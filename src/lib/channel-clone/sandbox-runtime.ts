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

export interface IntakeSandbox {
  sandbox: Sandbox;
  /** The default cwd for commands inside the sandbox; matches the
   *  Vercel Sandbox runtime convention. yt-dlp + ffmpeg both write
   *  their outputs into a subdirectory under this. */
  workDir: string;
}

/** Hard timeout for the sandbox itself. Generous so a slow apt + pip
 *  install + 5 yt-dlp downloads don't trip the cap; the inner intake
 *  runner has tighter per-command timeouts. */
const SANDBOX_LIFETIME_MS = 30 * 60_000;

const APT_INSTALL_TIMEOUT_MS = 90_000;
const PIP_INSTALL_TIMEOUT_MS = 90_000;

/** Create a python3.13 sandbox preloaded with yt-dlp + ffmpeg.
 *  Throws when VERCEL_OIDC_TOKEN is missing (the SDK auth path
 *  requires it; locally `vercel env pull` provisions it). */
export async function createIntakeSandbox(jobId: string): Promise<IntakeSandbox> {
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      'VERCEL_OIDC_TOKEN missing. Locally: run `vercel env pull` to populate `.env.development.local`. In production: Vercel auto-injects this on every function invocation.',
    );
  }

  logger.info('[channel-clone sandbox] create start', { jobId });
  const sandbox = await Sandbox.create({
    runtime: 'python3.13',
    timeout: SANDBOX_LIFETIME_MS,
  });
  const workDir = '/home/vercel-sandbox';
  logger.info('[channel-clone sandbox] created', { jobId, sandboxName: sandbox.name });

  // 1. ffmpeg via apt. The python3.13 runtime is Debian-based, so
  // apt-get works. --no-install-recommends keeps the install small.
  await runOrThrow(sandbox, 'apt install ffmpeg', {
    cmd: 'apt-get',
    args: ['install', '-y', '--no-install-recommends', 'ffmpeg'],
    sudo: true,
    timeoutMs: APT_INSTALL_TIMEOUT_MS,
  });

  // 2. yt-dlp via pip. The python3.13 runtime already has pip on the
  // PATH; --quiet keeps the install log tight.
  await runOrThrow(sandbox, 'pip install yt-dlp', {
    cmd: 'pip',
    args: ['install', '--quiet', '--no-input', 'yt-dlp'],
    timeoutMs: PIP_INSTALL_TIMEOUT_MS,
  });

  logger.info('[channel-clone sandbox] ready', { jobId, sandboxName: sandbox.name });
  return { sandbox, workDir };
}

/** Stop the sandbox + log billable usage. Swallows errors so the
 *  caller's failure path isn't masked by a stop-time exception —
 *  Vercel reaps orphans on the sandbox's own lifetime timeout anyway. */
export async function destroyIntakeSandbox(jobId: string, ctx: IntakeSandbox): Promise<void> {
  try {
    await ctx.sandbox.stop();
    logger.info('[channel-clone sandbox] stopped', {
      jobId,
      sandboxName: ctx.sandbox.name,
      activeCpuUsageMs: ctx.sandbox.activeCpuUsageMs ?? null,
    });
  } catch (err) {
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
    throw new Error(`${label} exited with code ${exitCode}: ${stderr.slice(-500).trim()}`);
  }
}
