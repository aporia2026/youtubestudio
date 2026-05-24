/**
 * System-wide auto-upscale via Recraft Crisp Upscale on Kie.ai.
 *
 * Every cloud (kie) image-generation surface in this app pairs its
 * generation call with an upscale pass through this module. Net result:
 * each shot lands at ~4K from a 1K source generation, at the cost of
 * one upscale call (~$0.0025/image, ~5–15s latency).
 *
 * Spec: docs.kie.ai/market/recraft/crisp-upscale
 *   - model: `recraft/crisp-upscale`
 *   - input: `{ image: <url> }` (URL only, max 10MB, PNG/JPG/WebP)
 *   - output: standard kie task lifecycle (createTask → pollKieResult)
 *   - cost: $0.0025/image
 *
 * Wired into the existing `kie-poll.ts` pipeline via the
 * `pollKieResultThenUpscale` wrapper — callers opt in by swapping
 * `pollKieResult` for the wrapper in one line.
 *
 * Skip rules (cost discipline, per the 2026-05-24 plan):
 *   1. Env kill-switch: `AUTO_UPSCALE_ENABLED=false` → skip everywhere,
 *      no kie task created. Lets us flip off without a redeploy if
 *      Recraft has an outage.
 *   2. Already-large: source image with long edge > 2000px → skip.
 *      Upscaling a 4K image to 16K wastes money + may add artifacts.
 *      Dimension probe via sharp metadata.
 *
 * Failure mode (graceful):
 *   - Retry once on any error (transient 429, 5xx, timeout).
 *   - On second failure: return the original (un-upscaled) image URL
 *     and log a warning. Never fails the parent generation — a vendor
 *     blip shouldn't punish the user.
 */
import sharp from 'sharp';
import { createKieTask, pollKieResult } from './kie-poll';
import { AUTO_UPSCALE_ENABLED } from './feature-flags';
import { logger } from './logger';

const RECRAFT_UPSCALE_MODEL = 'recraft/crisp-upscale';
const LONG_EDGE_THRESHOLD_PX = 2000;

export interface UpscaleResult {
  /** The final URL — upscaled if successful, original if any skip/failure path fired. */
  url: string;
  /** Why the final URL is what it is. Useful for telemetry + tester UI. */
  reason: 'upscaled' | 'skip_kill_switch' | 'skip_no_api_key' | 'skip_too_large' | 'failed_graceful_fallback';
  /** Long edge of the source in px when probed. Undefined when skipped before probing. */
  sourceLongEdgePx?: number;
  /** Total time spent in this helper, including probe + kie task + poll. */
  totalMs: number;
  /** Attempts spent on the Recraft call itself (1 = first try succeeded, 2 = retry succeeded, 0 = never attempted). */
  attempts: number;
}

/**
 * Run a URL through Recraft Crisp Upscale, returning a permanent URL
 * to use downstream. Never throws — every failure path returns the
 * original URL with a `reason` describing why.
 *
 * The output URL is whatever Recraft returned (Kie CDN). Callers that
 * persist the URL should re-host it to R2 (the existing kie t2i routes
 * already do this in their post-pollKieResult block).
 */
export async function upscaleViaRecraft(imageUrl: string): Promise<UpscaleResult> {
  const t0 = Date.now();

  // ─── Kill switch ────────────────────────────────────────────────────
  // `AUTO_UPSCALE_ENABLED` is a default-on flag (see feature-flags.ts) —
  // only an explicit env value of `'false'` flips it off. Lets us flip
  // upscale OFF without a redeploy if Recraft has an outage.
  if (!AUTO_UPSCALE_ENABLED) {
    logger.info('[upscale recraft] skip kill-switch', {
      url_preview: imageUrl.slice(0, 80),
    });
    return { url: imageUrl, reason: 'skip_kill_switch', totalMs: Date.now() - t0, attempts: 0 };
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    // Same fail-soft posture as the rest of the kie integration — if
    // the env is broken, return the un-upscaled URL rather than 500ing
    // the parent generation.
    logger.warn('[upscale recraft] skip no-api-key');
    return { url: imageUrl, reason: 'skip_no_api_key', totalMs: Date.now() - t0, attempts: 0 };
  }

  // ─── Skip-if-large probe ────────────────────────────────────────────
  // Fetch + read header bytes via sharp to learn the dimensions cheaply.
  // sharp.metadata() reads only the header, not the full pixel buffer,
  // so memory cost stays small even for ~10 MB inputs.
  const dims = await probeDimensions(imageUrl);
  const longEdge = dims ? Math.max(dims.width, dims.height) : undefined;
  if (longEdge !== undefined && longEdge > LONG_EDGE_THRESHOLD_PX) {
    logger.info('[upscale recraft] skip too-large', {
      long_edge_px: longEdge,
      threshold_px: LONG_EDGE_THRESHOLD_PX,
      url_preview: imageUrl.slice(0, 80),
    });
    return {
      url: imageUrl,
      reason: 'skip_too_large',
      sourceLongEdgePx: longEdge,
      totalMs: Date.now() - t0,
      attempts: 0,
    };
  }

  // ─── Try → retry once → graceful fallback ───────────────────────────
  // Two attempts total. Any error class triggers the retry (transient
  // 429, 5xx, timeout, parse error). On the second failure we return
  // the original URL — the parent generation already succeeded, so
  // shipping an un-upscaled image is better than 500ing.
  let lastError: string = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptStart = Date.now();
    try {
      logger.info('[upscale recraft] start', {
        attempt,
        source_long_edge_px: longEdge,
        url_preview: imageUrl.slice(0, 80),
      });
      const taskId = await createKieTask(apiKey, RECRAFT_UPSCALE_MODEL, { image: imageUrl });
      const upscaledUrl = await pollKieResult(taskId, apiKey);
      logger.info('[upscale recraft] success', {
        task_id: taskId,
        attempt,
        attempt_ms: Date.now() - attemptStart,
        total_ms: Date.now() - t0,
      });
      return {
        url: upscaledUrl,
        reason: 'upscaled',
        sourceLongEdgePx: longEdge,
        totalMs: Date.now() - t0,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Truncate to keep the log line small — full errors can be Kie
      // HTML pages or long stack traces that drown the log drain.
      logger.warn('[upscale recraft] retry', {
        attempt,
        attempt_ms: Date.now() - attemptStart,
        error: lastError.slice(0, 200),
      });
    }
  }

  logger.warn('[upscale recraft] failed graceful-fallback', {
    error: lastError.slice(0, 200),
    source_long_edge_px: longEdge,
    total_ms: Date.now() - t0,
    original_url_preview: imageUrl.slice(0, 80),
  });
  return {
    url: imageUrl,
    reason: 'failed_graceful_fallback',
    sourceLongEdgePx: longEdge,
    totalMs: Date.now() - t0,
    attempts: 2,
  };
}

/**
 * Fetch the source image and read its dimensions via sharp metadata.
 * Returns `null` on any failure (network error, non-image content,
 * sharp parse error) — the caller treats null as "unknown dimensions,
 * upscale anyway" rather than blocking the whole operation on a probe
 * failure.
 *
 * sharp.metadata() reads only the header, not the full pixel buffer,
 * so we tolerate large inputs without memory pressure. The 30s fetch
 * timeout protects against a hung kie CDN response stalling the
 * upscale path.
 */
async function probeDimensions(imageUrl: string): Promise<{ width: number; height: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(imageUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      logger.warn('[upscale recraft] probe fetch failed', {
        status: res.status,
        url_preview: imageUrl.slice(0, 80),
      });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
      return null;
    }
    return { width: meta.width, height: meta.height };
  } catch (err) {
    logger.warn('[upscale recraft] probe failed', {
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      url_preview: imageUrl.slice(0, 80),
    });
    return null;
  }
}
