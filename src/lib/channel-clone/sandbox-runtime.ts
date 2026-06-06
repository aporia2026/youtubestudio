/**
 * Vercel Sandbox lifecycle for channel-clone intake.
 *
 * yt-dlp + ffmpeg don't ship with the Vercel function runtime, so the
 * intake stage spins up a per-job Firecracker microVM via
 * `@vercel/sandbox`, installs the two binaries, hands the sandbox to
 * `yt-dlp.ts` / `ffmpeg.ts` for the actual work, then stops it.
 *
 * Plan: `_plans/2026-06-06-channel-clone-vercel-sandbox.md`.
 *
 * Security (rule 13):
 *   - VERCEL_OIDC_TOKEN is read from env; never logged or echoed.
 *   - Sandbox is a microVM — strong isolation from our function and
 *     from other tenants.
 *   - All commands run argv-array (no shell parsing of user input).
 *   - The sandbox auto-stops on `stop()`; even on a thrown error in
 *     intake the runner's finally block runs so we don't orphan VMs.
 *
 * Cost (rule 8 — checked 2026-06-06):
 *   - Active CPU: ~$0.15/hour (regional, $0.128–$0.221).
 *   - Provisioned memory: ~$0.013/GB-hour.
 *   - Creations: $0.60 per million ($0.0000006 each — negligible).
 *   - A 5-video intake ≈ $0.004. 1000 intakes ≈ $4.
 */

import { Sandbox } from '@vercel/sandbox';
import { logger } from '@/lib/logger';
import type { JobLogger } from './job-logger';

export interface IntakeSandbox {
  sandbox: Sandbox;
  /** The default cwd for commands inside the sandbox; matches the
   *  Vercel Sandbox runtime convention. yt-dlp + ffmpeg both write
   *  their outputs into a subdirectory under this. */
  workDir: string;
  /** Absolute path to the ffmpeg binary INSIDE the sandbox. We
   *  install ffmpeg via the `imageio-ffmpeg` pip package (which
   *  bundles a static Linux binary) rather than the runtime's
   *  native package manager — the python3.13 runtime isn't Debian-
   *  based so `apt-get` doesn't exist. Resolved once at sandbox
   *  setup and reused for every ffmpeg + yt-dlp call (yt-dlp needs
   *  this via `--ffmpeg-location` to merge video+audio streams). */
  ffmpegPath: string;
}

/** Hard timeout for the sandbox itself. Generous so a slow apt + pip
 *  install + 5 yt-dlp downloads don't trip the cap; the inner intake
 *  runner has tighter per-command timeouts. */
const SANDBOX_LIFETIME_MS = 30 * 60_000;

const PIP_INSTALL_TIMEOUT_MS = 120_000;
const FFMPEG_RESOLVE_TIMEOUT_MS = 60_000;

/** Resolve the credentials we'll hand to Sandbox.create. Two paths
 *  are supported, in order of preference:
 *
 *  1. **OIDC**: the SDK reads `VERCEL_OIDC_TOKEN` from env. On
 *     production deployments this is auto-injected on every function
 *     invocation, BUT ONLY if the project has OIDC enabled in
 *     Settings → Security → OIDC Token. Locally, `vercel env pull`
 *     copies a short-lived token into `.env.development.local`.
 *
 *  2. **Personal access token (fallback)**: when all three of
 *     `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` are set,
 *     we hand them to the SDK explicitly. This is the escape hatch
 *     for projects where OIDC can't (yet) be enabled. PATs are
 *     long-lived so prefer OIDC for production.
 *
 *  Returns `undefined` to mean "let the SDK auto-resolve from env"
 *  (the OIDC path). Returns an explicit credentials object when the
 *  PAT fallback is configured. */
function resolveSandboxCredentials():
  | undefined
  | { token: string; teamId: string; projectId: string }
{
  if (process.env.VERCEL_OIDC_TOKEN) {
    // SDK will pick it up automatically — no need to pass.
    return undefined;
  }
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return undefined;
}

/** Create a python3.13 sandbox preloaded with yt-dlp + ffmpeg.
 *
 *  Throws a setup-friendly error when neither auth path is configured.
 *  Otherwise delegates auth to the SDK (OIDC) or passes explicit
 *  creds (PAT fallback).
 *
 *  The optional `log` is a JobLogger from the runner. Every meaningful
 *  step is published both to the server log AND to the job's
 *  progressLog so the panel renders live progress. */
export async function createIntakeSandbox(jobId: string, log?: JobLogger): Promise<IntakeSandbox> {
  const creds = resolveSandboxCredentials();
  if (!creds && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      'Vercel Sandbox auth not configured. Pick one path:\n' +
      '  1. RECOMMENDED — enable OIDC: Vercel dashboard → Project → Settings → Security → OIDC Token → Enable. Then redeploy; VERCEL_OIDC_TOKEN auto-injects.\n' +
      '  2. ALTERNATIVE — set Personal Access Token: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID env vars (less secure; PATs are long-lived).\n' +
      '  3. LOCAL DEV — run `vercel env pull` to copy a short-lived OIDC token into .env.development.local.',
    );
  }

  log?.info('sandbox', 'create start', { auth: creds ? 'explicit-pat' : 'oidc' });
  logger.info('[channel-clone sandbox] create start', { jobId, auth: creds ? 'explicit-pat' : 'oidc' });
  const sandbox = await Sandbox.create({
    runtime: 'python3.13',
    timeout: SANDBOX_LIFETIME_MS,
    ...(creds ?? {}),
  });
  const workDir = '/home/vercel-sandbox';
  log?.info('sandbox', 'created', { sandboxName: sandbox.name });
  logger.info('[channel-clone sandbox] created', { jobId, sandboxName: sandbox.name });

  // 1+2. Install yt-dlp AND imageio-ffmpeg (the latter bundles a
  // static ffmpeg binary). One pip call for both — the python3.13
  // runtime isn't Debian so `apt-get install ffmpeg` doesn't work;
  // imageio-ffmpeg is the portable path.
  log?.info('sandbox', 'pip install yt-dlp + imageio-ffmpeg (this takes ~20s, includes ~50MB static ffmpeg download)');
  await runOrThrow(sandbox, 'pip install yt-dlp + imageio-ffmpeg', {
    cmd: 'pip',
    args: ['install', '--quiet', '--no-input', 'yt-dlp', 'imageio-ffmpeg'],
    timeoutMs: PIP_INSTALL_TIMEOUT_MS,
  });
  log?.info('sandbox', 'pip install done');

  // 3. Resolve the bundled ffmpeg path so ffmpeg.ts and yt-dlp can
  // exec it directly. imageio_ffmpeg.get_ffmpeg_exe() lazily
  // downloads the binary on first call (~50MB, one-shot) and
  // returns its absolute path.
  const probe = await runInSandbox(sandbox, {
    cmd: 'python',
    args: ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
    timeoutMs: FFMPEG_RESOLVE_TIMEOUT_MS,
  });
  if (probe.exitCode !== 0) {
    throw new Error(`could not resolve ffmpeg path: ${probe.stderr.slice(-2000).trim()}`);
  }
  const ffmpegPath = probe.stdout.trim();
  if (!ffmpegPath || !ffmpegPath.startsWith('/')) {
    throw new Error(`imageio_ffmpeg returned an unexpected ffmpeg path: ${ffmpegPath || '(empty)'}`);
  }
  log?.info('sandbox', 'ffmpeg resolved', { ffmpegPath });

  log?.info('sandbox', 'ready');
  logger.info('[channel-clone sandbox] ready', { jobId, sandboxName: sandbox.name, ffmpegPath });
  return { sandbox, workDir, ffmpegPath };
}

/** Stop the sandbox + log billable usage. Swallows errors so the
 *  caller's failure path isn't masked by a stop-time exception —
 *  Vercel reaps orphans on the sandbox's own lifetime timeout anyway. */
export async function destroyIntakeSandbox(jobId: string, ctx: IntakeSandbox, log?: JobLogger): Promise<void> {
  try {
    await ctx.sandbox.stop();
    log?.info('sandbox', 'stopped', {
      sandboxName: ctx.sandbox.name,
      activeCpuUsageMs: ctx.sandbox.activeCpuUsageMs ?? null,
    });
    logger.info('[channel-clone sandbox] stopped', {
      jobId,
      sandboxName: ctx.sandbox.name,
      activeCpuUsageMs: ctx.sandbox.activeCpuUsageMs ?? null,
    });
  } catch (err) {
    log?.warn('sandbox', 'stop failed; relying on lifetime auto-reap', {
      error: err instanceof Error ? err.message : String(err),
    });
    logger.warn('[channel-clone sandbox] stop failed; relying on lifetime auto-reap', {
      jobId,
      sandboxName: ctx.sandbox.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RunInSandboxParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  sudo?: boolean;
  timeoutMs?: number;
}

export interface RunInSandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command in the sandbox and collect its full stdout/stderr.
 *  Non-throwing — returns the exit code so the caller decides what to
 *  treat as failure (some workflows tolerate non-zero, e.g. yt-dlp
 *  warning about missing captions still wrote the video). */
export async function runInSandbox(
  sandbox: Sandbox,
  params: RunInSandboxParams,
): Promise<RunInSandboxResult> {
  const result = await sandbox.runCommand({
    cmd: params.cmd,
    args: params.args,
    cwd: params.cwd,
    sudo: params.sudo,
    timeoutMs: params.timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    result.stdout().catch(() => ''),
    result.stderr().catch(() => ''),
  ]);
  return { stdout, stderr, exitCode: result.exitCode };
}

/** Throwing variant for setup steps where any non-zero exit code is
 *  fatal (apt install, pip install). Strips stderr to the last 500
 *  characters so the thrown message stays readable. */
async function runOrThrow(
  sandbox: Sandbox,
  label: string,
  params: RunInSandboxParams,
): Promise<void> {
  const { exitCode, stderr } = await runInSandbox(sandbox, params);
  if (exitCode !== 0) {
    throw new Error(`${label} exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }
}
