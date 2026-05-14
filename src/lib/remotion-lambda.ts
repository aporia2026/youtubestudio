/**
 * Distributed-render client for `@remotion/lambda`.
 *
 * Thin wrapper around two calls — `renderMediaOnLambda` to kick off,
 * `getRenderProgress` to poll — so the API route layer doesn't need to
 * know about region resolution, env-var contracts, or the wider
 * RenderProgress shape (most fields of which are noise for our use).
 *
 * Companion to `_plans/2026-05-13-lambda-render-migration.md`. Phase 3.
 */
import {
  deleteRender,
  getRenderProgress,
  renderMediaOnLambda,
  type AwsRegion,
} from '@remotion/lambda/client';

// ─── Config ────────────────────────────────────────────────────────────────────

/**
 * Resolved Lambda config. Always loaded fresh on each call so a process
 * doesn't hold stale env state if the deployer rotates a key without a
 * full restart (Vercel's serverless runtime occasionally reuses warm
 * containers across deploys for a few minutes).
 */
export interface LambdaConfig {
  functionName: string;
  serveUrl: string;
  region: AwsRegion;
}

const DEFAULT_REGION: AwsRegion = 'us-east-1';

/** True iff every required env var is present + non-empty. */
export function lambdaConfigured(): boolean {
  return Boolean(
    process.env.REMOTION_LAMBDA_FUNCTION_NAME &&
      process.env.REMOTION_LAMBDA_SERVE_URL &&
      (process.env.REMOTION_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
      (process.env.REMOTION_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY),
  );
}

/**
 * Read + validate config from env. Throws with a single actionable
 * message naming the missing var(s), so a misconfigured deploy fails
 * loud and obvious rather than fanning out into a SDK-internal stack.
 */
export function getLambdaConfig(): LambdaConfig {
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME?.trim();
  const serveUrl = process.env.REMOTION_LAMBDA_SERVE_URL?.trim();
  const region = (process.env.REMOTION_LAMBDA_REGION?.trim() || DEFAULT_REGION) as AwsRegion;

  const missing: string[] = [];
  if (!functionName) missing.push('REMOTION_LAMBDA_FUNCTION_NAME');
  if (!serveUrl) missing.push('REMOTION_LAMBDA_SERVE_URL');
  if (missing.length > 0) {
    throw new Error(
      `Lambda backend requested but ${missing.join(' + ')} not set. ` +
        `See _plans/2026-05-13-lambda-render-migration.md → Phase 2.`,
    );
  }

  return { functionName: functionName!, serveUrl: serveUrl!, region };
}

// ─── Kick off ──────────────────────────────────────────────────────────────────

export interface LambdaKickoffInput {
  compositionId: string;
  inputProps: Record<string, unknown>;
  /** Defaults to 'h264' to mirror the Vercel render path. */
  codec?: 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores';
}

export interface LambdaKickoffResult {
  /** Remotion's own render id — distinct from `render_jobs.id`. */
  lambdaRenderId: string;
  /** Per-region S3 bucket Lambda writes outputs into. Needed for polling. */
  bucketName: string;
}

/**
 * How many frames each Lambda invocation renders. Higher values =
 * fewer concurrent Lambdas spawned for a given video length, which
 * keeps a fresh AWS account (default 10-concurrency quota) from
 * tripping `AWS Concurrency limit reached (Rate Exceeded)`.
 *
 * Default 4800 = 160 s of 30-fps video per chunk → a 14-minute video
 * spawns ~5 Lambdas. Once AWS approves a quota increase (Service
 * Quotas → Lambda → Concurrent executions), drop this to ~500 to get
 * the full ~75-90 s wall-time the plan targets.
 */
const DEFAULT_FRAMES_PER_LAMBDA = 4800;

/**
 * Retry count for transient Lambda failures, including the brief
 * `Rate Exceeded` spikes you can still see even with framesPerLambda
 * tuned. Remotion handles the back-off internally.
 */
const DEFAULT_MAX_RETRIES = 3;

function getFramesPerLambda(): number {
  const raw = process.env.REMOTION_LAMBDA_FRAMES_PER_LAMBDA;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FRAMES_PER_LAMBDA;
}

function getMaxRetries(): number {
  const raw = process.env.REMOTION_LAMBDA_MAX_RETRIES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}

/**
 * Fire a distributed render. Returns in ~100–300ms with the ids needed
 * to poll progress. Does NOT wait for the render to finish.
 */
export async function kickOffLambdaRender(
  input: LambdaKickoffInput,
): Promise<LambdaKickoffResult> {
  const cfg = getLambdaConfig();

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: cfg.region,
    functionName: cfg.functionName,
    serveUrl: cfg.serveUrl,
    composition: input.compositionId,
    inputProps: input.inputProps,
    codec: input.codec ?? 'h264',
    // Output privacy 'public' matches the existing Vercel-Blob contract
    // for `/api/render/video`. Switch to 'private' + presigned URLs once
    // a private-draft requirement lands.
    privacy: 'public',
    // Concurrency tuning — see DEFAULT_FRAMES_PER_LAMBDA above for the
    // rationale. Each value can be overridden via env so the deployer
    // can re-tune without a code change once AWS raises their quota.
    framesPerLambda: getFramesPerLambda(),
    maxRetries: getMaxRetries(),
  });

  return { lambdaRenderId: renderId, bucketName };
}

// ─── Poll ──────────────────────────────────────────────────────────────────────

export interface LambdaProgressSnapshot {
  /** 0..1, monotonically increasing in practice. */
  overallProgress: number;
  done: boolean;
  /** S3 URL of the rendered MP4 once `done === true`, else null. */
  outputFile: string | null;
  /** First fatal error message, or null. Non-fatal chunk retries are not surfaced. */
  fatalError: string | null;
  /** USD accrued so far. Final on completion. */
  costAccrued: number;
}

/**
 * Snapshot the current render state. Cheap (one Lambda invoke, billed
 * at ~$0.000002 per call); safe to call every 2–3s from the GET poll
 * route.
 */
export async function pollLambdaProgress(params: {
  lambdaRenderId: string;
  bucketName: string;
}): Promise<LambdaProgressSnapshot> {
  const cfg = getLambdaConfig();

  const progress = await getRenderProgress({
    region: cfg.region,
    functionName: cfg.functionName,
    bucketName: params.bucketName,
    renderId: params.lambdaRenderId,
  });

  const fatalError = progress.fatalErrorEncountered
    ? progress.errors[0]?.message ?? 'Lambda render failed'
    : null;

  return {
    overallProgress: progress.overallProgress,
    done: progress.done,
    outputFile: progress.outputFile,
    fatalError,
    costAccrued: progress.costs.accruedSoFar,
  };
}

// ─── Cancel ────────────────────────────────────────────────────────────────────

/**
 * Abort an in-flight render and clean up its S3 artefacts. Used by the
 * Phase 5 per-render spend cap when a runaway render exceeds budget.
 * Idempotent on Remotion's side — calling on a finished render just
 * deletes the output.
 */
export async function deleteLambdaRender(params: {
  lambdaRenderId: string;
  bucketName: string;
}): Promise<{ freedBytes: number }> {
  const cfg = getLambdaConfig();
  return deleteRender({
    region: cfg.region,
    bucketName: params.bucketName,
    renderId: params.lambdaRenderId,
  });
}
