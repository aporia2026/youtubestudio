/**
 * Retry helper for the shorts-batch orchestrator's stage runners.
 *
 * Plan: _plans/2026-06-09-bulk-shorts-robustness-and-inspector.md.
 *
 * Why: every orchestrator stage (`runExtractStage`, `runVoiceoverStage`,
 * `runSeoStage`, `runTriggerRenderStage`) used to mark a short as
 * permanently failed on the first thrown error. A transient upstream
 * blip — Kie's "code 500: server is currently being maintained" being
 * the canonical example — became a terminal error the user had to
 * manually clear from the DB. This wrapper survives those blips by
 * retrying the same call with exponential backoff, but only for failure
 * classes that retrying could plausibly fix.
 *
 * Classification is delegated to `classifyFailure()` in `./ai-fallback.ts`
 * so we stay aligned with the auto-pipeline's classifier — the load-bearing
 * rule is the same: **content refusals never trigger retry**, because a
 * model declining to write something is a content decision, not a
 * transient error.
 */

import { classifyFailure } from './ai-fallback';

/** Failure classes worth retrying. `transient_5xx`, `rate_limit`, and
 *  `timeout` are the ones where the same prompt + same model has a
 *  meaningful chance of succeeding on a second attempt. Refusals,
 *  malformed responses, and unknown errors short-circuit immediately. */
const RETRY_CLASSES: ReadonlySet<string> = new Set([
  'transient_5xx',
  'rate_limit',
  'timeout',
]);

export interface RetryOptions {
  /** Hard ceiling on attempts (including the first). Defaults to 3 —
   *  enough to ride out a brief Kie maintenance window without
   *  blowing the per-tick wall-clock budget. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Exponential after.
   *  Defaults to 1000. Schedule with defaults: ~1s, ~3s. */
  baseDelayMs?: number;
  /** Multiplier between retries. Defaults to 3 (1s → 3s → 9s).
   *  Combined with `maxAttempts=3` the worst-case added wait is
   *  ~4s before the second retry, before we give up. */
  factor?: number;
  /** Cap on a single backoff delay. Prevents the rare combination
   *  (high maxAttempts + high factor) from sleeping for a minute. */
  maxDelayMs?: number;
  /** Per-attempt callback for observability. Called once per
   *  retry (i.e. NOT on the initial attempt, and NOT after the
   *  last failure). Stage runners use this to emit a
   *  `[shorts-batch retry]` log line. */
  onRetry?: (info: { attempt: number; delayMs: number; failureClass: string; message: string }) => void;
  /** Override for the classifier. Tests inject a fake to validate
   *  retry policy without depending on the message-text heuristics. */
  classify?: (err: unknown) => string;
  /** Override for the delay primitive. Tests inject `() => Promise.resolve()`
   *  to skip real waits. */
  sleep?: (ms: number) => Promise<void>;
}

/** Compute the backoff delay before retry attempt `n` (1-indexed:
 *  n=1 is the wait before the second total attempt). Adds ±20%
 *  jitter so multiple concurrent shorts that hit the same Kie
 *  outage don't all hammer the gateway in lockstep. Pure — tested
 *  separately. */
export function computeBackoffMs(
  attemptIndex: number,
  baseDelayMs: number,
  factor: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const raw = baseDelayMs * Math.pow(factor, attemptIndex - 1);
  const capped = Math.min(raw, maxDelayMs);
  // ±20% jitter, deterministic when `random` is injected.
  const jitter = (random() - 0.5) * 0.4; // [-0.2, +0.2]
  return Math.max(0, Math.round(capped * (1 + jitter)));
}

/** True when the classifier says the failure has a meaningful chance
 *  of succeeding on retry. Pure — tested separately. */
export function isRetryableFailureClass(failureClass: string): boolean {
  return RETRY_CLASSES.has(failureClass);
}

/**
 * Run `fn`, retrying on transient classes with exponential backoff +
 * jitter. Returns the successful result, or rethrows the last error
 * (preserving the original Error instance so the caller's catch sees
 * the same shape it always saw).
 *
 * Never swallows refusals or 4xx — those rethrow on the first failure.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 1000);
  const factor = Math.max(1, opts.factor ?? 3);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 15_000);
  const classify = opts.classify ?? classifyFailure;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const failureClass = classify(err);
      const isLast = attempt === maxAttempts;
      if (isLast || !isRetryableFailureClass(failureClass)) {
        throw err;
      }
      const delayMs = computeBackoffMs(attempt, baseDelayMs, factor, maxDelayMs);
      opts.onRetry?.({
        attempt,
        delayMs,
        failureClass,
        message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop always either returns or throws.
  throw lastError;
}
