/**
 * Kie.ai image generation with model fallback chain.
 *
 * Server-only. Used by the thumbnail stage handler — the existing
 * production-doc-image route at
 * src/app/api/generate/production-doc/image/route.ts uses an
 * inline single-model call; this helper adds the fallback-chain
 * mechanic that the auto-pipeline needs.
 *
 * Behaviour mirrors `generateTextWithFallback` for consistency:
 *   - Try each model in `chain` in order.
 *   - On transient failure (5xx / rate-limit / timeout), advance
 *     to the next model.
 *   - On content refusal (Kie's "nsfw_checker" or moderation
 *     responses), short-circuit — don't fall through, since the
 *     refusal is a content signal.
 *   - On chain exhaustion, throw with the last failure class.
 *
 * Result image is re-hosted to Vercel Blob so the returned URL
 * doesn't expire (Kie's URLs have a short TTL).
 *
 * Image-cost telemetry: Kie pricing isn't tracked in
 * `ai-pricing.ts` (the plan flagged this). Cost is passed as $0
 * on the artefact for now; a follow-up ticket adds image
 * pricing.
 */
import { put } from '@vercel/blob';
import { buildKieImageInput, getImageModelSpec } from '../image-models';
import { logger } from '../logger';

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

export interface GenerateImageAttempt {
  modelValue: string;
  failureClass?: 'transient_5xx' | 'rate_limit' | 'timeout' | 'empty_or_malformed' | 'content_refusal' | 'unknown';
  failureMessage?: string;
  durationMs: number;
}

export interface GenerateImageResult {
  imageUrl: string;
  modelUsed: string;
  attempts: ReadonlyArray<GenerateImageAttempt>;
}

export class ImageGenerationFailure extends Error {
  public readonly attempts: ReadonlyArray<GenerateImageAttempt>;
  public readonly lastFailureClass: string;
  constructor(attempts: ReadonlyArray<GenerateImageAttempt>) {
    const last = attempts[attempts.length - 1];
    super(`image generation failed across ${attempts.length} model(s); last: ${last?.failureClass ?? 'unknown'}: ${last?.failureMessage ?? 'no message'}`);
    this.name = 'ImageGenerationFailure';
    this.attempts = attempts;
    this.lastFailureClass = last?.failureClass ?? 'unknown';
  }
}

/**
 * Generate one image, walking the model chain on transient
 * failure. Returns a Vercel-Blob-hosted permanent URL.
 *
 * `chain` is an ordered list of image-model `value` ids (from
 * `IMAGE_MODELS`). Unknown ids are filtered out.
 */
export async function generateImageWithFallback(
  chain: readonly string[],
  prompt: string,
  opts: { blobPathPrefix?: string } = {},
): Promise<GenerateImageResult> {
  if (chain.length === 0) {
    throw new Error('generateImageWithFallback: empty chain');
  }
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    throw new Error('KIE_API_KEY is not configured');
  }
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('generateImageWithFallback: empty prompt');
  }
  if (trimmedPrompt.length > 1500) {
    throw new Error('generateImageWithFallback: prompt > 1500 chars');
  }

  const attempts: GenerateImageAttempt[] = [];
  const fallbackClasses = new Set(['transient_5xx', 'rate_limit', 'timeout', 'empty_or_malformed']);

  for (const modelValue of chain) {
    const spec = getImageModelSpec(modelValue);
    if (!spec) {
      logger.warn('auto-pipeline image-gen: unknown model in chain, skipping', { model: modelValue });
      continue;
    }

    const t0 = Date.now();
    try {
      const kieUrl = await callKie(spec.kieModel, spec.value, trimmedPrompt, apiKey);
      const hosted = await reHostToBlob(kieUrl, opts.blobPathPrefix);
      attempts.push({ modelValue, durationMs: Date.now() - t0 });
      logger.info('auto-pipeline image-gen: succeeded', {
        model: modelValue,
        attempt_count: attempts.length,
        duration_ms: Date.now() - t0,
      });
      return { imageUrl: hosted, modelUsed: modelValue, attempts };
    } catch (err) {
      const failureClass = classifyImageFailure(err);
      const failureMessage = err instanceof Error ? err.message : String(err);
      attempts.push({ modelValue, failureClass, failureMessage, durationMs: Date.now() - t0 });
      logger.warn('auto-pipeline image-gen: attempt failed', {
        model: modelValue,
        failure_class: failureClass,
        detail: failureMessage.slice(0, 200),
      });
      if (!fallbackClasses.has(failureClass)) {
        // Content refusal / unknown — short-circuit. Council
        // pattern matches the text wrapper.
        throw new ImageGenerationFailure(attempts);
      }
      // Else loop to next model.
    }
  }

  throw new ImageGenerationFailure(attempts);
}

// ─── Kie API plumbing ───────────────────────────────────────────────

async function callKie(kieModel: string, modelValue: string, prompt: string, apiKey: string): Promise<string> {
  // Create the task — retry on 5xx gateway flaps up to 3 times.
  let createRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    createRes = await fetch(`${KIE_BASE}/createTask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: kieModel,
        input: buildKieImageInput(modelValue, prompt),
      }),
    });
    if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
  }
  if (!createRes || !createRes.ok) {
    throw new Error(await kieErrorMessage(createRes));
  }

  let createData: Record<string, unknown>;
  try {
    createData = await createRes.json();
  } catch {
    throw new Error('Kie.ai returned non-JSON response during task creation');
  }
  const taskId = (createData.data as Record<string, unknown> | undefined)?.taskId as string | undefined;
  if (!taskId) throw new Error('No taskId returned from Kie.ai');

  // Poll for the result — 30 × 3s = 90s ceiling.
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const pollRes = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!pollRes.ok) {
      if (pollRes.status === 429) continue;
      throw new Error(`Poll failed: ${pollRes.status}`);
    }
    let pollData: Record<string, unknown>;
    try {
      pollData = await pollRes.json();
    } catch {
      continue; // transient
    }
    const state = (pollData.data as Record<string, unknown> | undefined)?.state;
    if (state === 'success') {
      const dataObj = pollData.data as Record<string, unknown>;
      let parsed: Record<string, unknown>;
      try {
        parsed = typeof dataObj.resultJson === 'string'
          ? (JSON.parse(dataObj.resultJson) as Record<string, unknown>)
          : (dataObj.resultJson as Record<string, unknown>);
      } catch {
        throw new Error('Invalid result JSON from Kie.ai');
      }
      const urls = parsed?.resultUrls as string[] | undefined;
      if (!urls?.length) throw new Error('No image URLs in result');
      return urls[0];
    }
    if (state === 'fail') {
      const dataObj = pollData.data as Record<string, unknown>;
      throw new Error((dataObj?.failMsg as string) || 'Image generation failed on Kie.ai');
    }
    // waiting / queuing / generating — keep polling
  }
  throw new Error('Image generation timed out after 90s');
}

async function reHostToBlob(kieUrl: string, prefix = 'pipeline-thumbnails'): Promise<string> {
  try {
    const imgRes = await fetch(kieUrl);
    if (!imgRes.ok) {
      logger.warn('image-gen: re-host fetch failed, returning Kie URL', { status: imgRes.status });
      return kieUrl;
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const buffer = await imgRes.arrayBuffer();
    const blob = await put(`${prefix}/${Date.now()}.jpg`, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    logger.warn('image-gen: re-host failed, falling back to Kie URL', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return kieUrl;
  }
}

async function kieErrorMessage(res: Response | null): Promise<string> {
  if (!res) return 'No response from Kie.ai';
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status >= 500) return `Kie.ai is temporarily unavailable (${res.status})`;
    return `Kie.ai gateway error (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string') return `Kie.ai: ${msg}`;
  } catch { /* not JSON */ }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

function classifyImageFailure(err: unknown): GenerateImageAttempt['failureClass'] & string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (/\b429\b/.test(msg) || lower.includes('rate limit')) return 'rate_limit';
  if (/\b5\d{2}\b/.test(msg) || lower.includes('unavailable') || lower.includes('bad gateway')) return 'transient_5xx';
  if (lower.includes('nsfw') || lower.includes('policy') || lower.includes('refused') || lower.includes('safety')) return 'content_refusal';
  if (lower.includes('no image urls') || lower.includes('no taskid')) return 'empty_or_malformed';
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
