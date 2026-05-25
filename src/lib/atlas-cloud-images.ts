/**
 * Atlas Cloud image-generation helpers (api.atlascloud.ai).
 *
 * Sibling to src/lib/kie-poll.ts — same async create+poll shape, different
 * vendor. Covers three modes against the OpenAI GPT Image 2 family hosted
 * by Atlas:
 *   - generateAtlasT2I:  text-to-image (openai/gpt-image-2/text-to-image)
 *   - generateAtlasEdit: image edit    (openai/gpt-image-2/edit)
 *   - generateAtlasI2I:  image-to-image (openai/gpt-image-2/image-to-image)
 *
 * Pricing as of 2026-05-25 from the Atlas Cloud catalog:
 *   - T2I:  $0.009/image (flat).
 *   - Edit: token-billed ($0.00003/output token + image + prompt tokens).
 *           Treat as ~$0.01/call for the cost model; log actual tokens for
 *           true-up.
 *   - I2I:  assumed flat (Atlas docs sparse); treat as $0.009/image until
 *           the first invoice confirms.
 *
 * 16:9 caveat
 *   Atlas's GPT Image 2 family does NOT accept 16:9 sizes — the documented
 *   `size` enum is 1024x1024 / 1024x1536 / 1536x1024 only. This module
 *   returns the raw vendor URL at whatever size was requested; the 16:9
 *   center-crop step lives in image-gen-dispatch.ts so the routes never
 *   see a 3:2 image.
 *
 * Mask gap
 *   Atlas Edit does NOT document a mask field. The eraser flow on
 *   /api/overlay/edit (which needs a mask) stays on Kie. This module does
 *   not expose a mask param; the edit registry in image-edit-models.ts
 *   carries a `supportsMask: false` flag for Atlas so the eraser surface
 *   filters Atlas Edit out at the picker level.
 *
 * Failure posture
 *   Throws plain Error on any non-success path. No silent fallback to
 *   another vendor — failure visibility is the locked product decision
 *   (see plan). The dispatcher decides what to surface to the user.
 *
 * See _plans/2026-05-25-atlas-cloud-gpt-image-2.md.
 */
import { logger } from './logger';

const ATLAS_BASE = 'https://api.atlascloud.ai/api/v1/model';

/** 3 s × 95 = 285 s ceiling, matching kie-poll.ts. Sits under the 300 s
 *  `maxDuration` on the image routes with ~15 s headroom for R2 mirror
 *  + saliency. Atlas docs suggest a 2-3 s poll cadence which lines up. */
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 95;

/** Atlas's documented `size` enum for the GPT Image 2 family. Source:
 *  atlascloud.ai/models/openai/gpt-image-2/text-to-image. Surfaces an
 *  enum union so callers (the dispatcher + registry extraInput) can
 *  only pass one of the three accepted shapes. */
export type AtlasSize = '1024x1024' | '1024x1536' | '1536x1024';

/** Atlas's documented `quality` tiers. Default is `'medium'` per their
 *  example payloads when omitted. */
export type AtlasQuality = 'low' | 'medium' | 'high';

/** Discriminated union of poll states Atlas can return. `'completed'`
 *  and `'succeeded'` are both treated as terminal-success because Atlas
 *  docs list both in different examples — defensive against either. */
type AtlasPredictionStatus = 'processing' | 'completed' | 'succeeded' | 'failed';

/** Atlas's response envelope on the poll endpoint, narrowed to the fields
 *  we actually read. `outputs` is documented as an array of URLs available
 *  once status flips terminal. `metrics` carries token counts on the Edit
 *  endpoint so we can log per-call cost — undefined on T2I where billing
 *  is flat per image. */
interface AtlasPredictionResponse {
  id: string;
  status: AtlasPredictionStatus;
  outputs?: string[];
  metrics?: {
    predict_time?: number;
    input_tokens?: number;
    output_tokens?: number;
    image_tokens?: number;
  };
  error?: string;
}

export interface AtlasT2IOpts {
  prompt: string;
  size: AtlasSize;
  quality?: AtlasQuality;
}

export interface AtlasEditOpts {
  prompt: string;
  /** One or more input image URLs. Atlas docs say "one or more" — the
   *  cap is not documented. The dispatcher trims to a conservative
   *  ceiling before reaching here. */
  images: string[];
  size?: AtlasSize;
  quality?: AtlasQuality;
}

export interface AtlasI2IOpts {
  prompt: string;
  /** Reference image URLs. Assumed multi-input via the same `images`
   *  field shape Edit uses; verified during implementation. */
  images: string[];
  size?: AtlasSize;
  quality?: AtlasQuality;
}

/**
 * Result envelope returned by every helper. Carries the URL plus the
 * predict_time + (for Edit) token-cost telemetry so the caller can log
 * per-call cost without re-fetching the prediction.
 */
export interface AtlasGenerateResult {
  url: string;
  predictionId: string;
  predictTimeMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    image?: number;
  };
}

/**
 * Generate a single image from a text prompt via Atlas GPT Image 2 T2I.
 * Returns the vendor CDN URL of the generated image at the requested size
 * (no aspect adjustment — the dispatcher handles the 16:9 crop).
 */
export async function generateAtlasT2I(opts: AtlasT2IOpts): Promise<AtlasGenerateResult> {
  return runAtlasGeneration({
    label: 't2i',
    model: 'openai/gpt-image-2/text-to-image',
    input: {
      prompt: opts.prompt,
      size: opts.size,
      ...(opts.quality ? { quality: opts.quality } : {}),
    },
    promptCharsForLog: opts.prompt.length,
  });
}

/**
 * Edit an existing image (or compose from one+ inputs) via Atlas GPT Image 2
 * Edit. `images` is an array of public URLs Atlas can fetch. No mask param
 * is supported by Atlas — for mask-bearing flows (eraser), use the Kie
 * route instead.
 */
export async function generateAtlasEdit(opts: AtlasEditOpts): Promise<AtlasGenerateResult> {
  if (opts.images.length === 0) {
    throw new Error('generateAtlasEdit: at least one input image URL is required');
  }
  return runAtlasGeneration({
    label: 'edit',
    model: 'openai/gpt-image-2/edit',
    input: {
      prompt: opts.prompt,
      images: opts.images,
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
    },
    promptCharsForLog: opts.prompt.length,
    refsCountForLog: opts.images.length,
  });
}

/**
 * Reference-driven generation via Atlas GPT Image 2 I2I. Same payload shape
 * as Edit — the distinction is semantic (Edit modifies an input, I2I uses
 * inputs as style/composition references). Atlas docs are sparse on the
 * exact distinction; a probe script verifies the multi-ref cap.
 */
export async function generateAtlasI2I(opts: AtlasI2IOpts): Promise<AtlasGenerateResult> {
  if (opts.images.length === 0) {
    throw new Error('generateAtlasI2I: at least one reference image URL is required');
  }
  return runAtlasGeneration({
    label: 'i2i',
    model: 'openai/gpt-image-2/image-to-image',
    input: {
      prompt: opts.prompt,
      images: opts.images,
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
    },
    promptCharsForLog: opts.prompt.length,
    refsCountForLog: opts.images.length,
  });
}

// ─── Internal create + poll plumbing ────────────────────────────────────────

interface AtlasRunOpts {
  label: 't2i' | 'edit' | 'i2i';
  model: string;
  input: Record<string, unknown>;
  promptCharsForLog: number;
  refsCountForLog?: number;
}

async function runAtlasGeneration(opts: AtlasRunOpts): Promise<AtlasGenerateResult> {
  const apiKey = process.env.ATLAS_CLOUD_API_KEY;
  if (!apiKey) {
    throw new Error('ATLAS_CLOUD_API_KEY is not configured');
  }

  const t0 = Date.now();
  logger.info(`[atlas-images ${opts.label}] start`, {
    model: opts.model,
    prompt_chars: opts.promptCharsForLog,
    ...(opts.refsCountForLog !== undefined ? { ref_count: opts.refsCountForLog } : {}),
  });

  const predictionId = await createAtlasPrediction(apiKey, opts.model, opts.input);
  const prediction = await pollAtlasPrediction(apiKey, predictionId, opts.label);

  const url = prediction.outputs?.[0];
  if (!url) {
    throw new Error(`Atlas ${opts.label}: prediction ${predictionId} completed without an output URL`);
  }

  const result: AtlasGenerateResult = {
    url,
    predictionId,
    predictTimeMs:
      typeof prediction.metrics?.predict_time === 'number'
        ? Math.round(prediction.metrics.predict_time * 1000)
        : undefined,
    tokens: prediction.metrics
      ? {
          input: prediction.metrics.input_tokens,
          output: prediction.metrics.output_tokens,
          image: prediction.metrics.image_tokens,
        }
      : undefined,
  };
  logger.info(`[atlas-images ${opts.label}] success`, {
    prediction_id: predictionId,
    predict_ms: result.predictTimeMs,
    total_ms: Date.now() - t0,
    output_url_preview: url.slice(0, 80),
    ...(result.tokens?.input !== undefined ? { input_tokens: result.tokens.input } : {}),
    ...(result.tokens?.output !== undefined ? { output_tokens: result.tokens.output } : {}),
    ...(result.tokens?.image !== undefined ? { image_tokens: result.tokens.image } : {}),
  });
  return result;
}

/**
 * POST /api/v1/model/generateImage with the {model, input} envelope Atlas
 * expects. Retries up to 3 × on transient 502/503/504 with linear backoff
 * (mirrors createKieTask). Throws an actionable Error on any non-2xx with
 * a `[atlas-images]`-prefixed message so the dispatcher's error toast is
 * vendor-attributable.
 */
async function createAtlasPrediction(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  let createRes!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    createRes = await fetch(`${ATLAS_BASE}/generateImage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
    });
    if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
  }
  if (!createRes.ok) {
    throw new Error(await atlasErrorMessage(createRes));
  }

  let createData: Record<string, unknown>;
  try {
    createData = await createRes.json();
  } catch {
    throw new Error('[atlas-images] non-JSON response during prediction creation');
  }

  const predictionId = createData.id as string | undefined;
  if (!predictionId) {
    const errorField = createData.error as string | undefined;
    const detail = errorField
      ? `Atlas responded error="${errorField}"`
      : `Atlas returned an unexpected body: ${JSON.stringify(createData).slice(0, 400)}`;
    throw new Error(`[atlas-images] no prediction id returned — ${detail}`);
  }
  return predictionId;
}

/**
 * Poll /api/v1/model/prediction/{id} until the prediction hits a terminal
 * state. Mirrors pollKieResult's shape: fixed 3 s interval × 95 attempts =
 * 285 s ceiling. 429 responses are retried without consuming an attempt
 * slot (rare in practice).
 */
async function pollAtlasPrediction(
  apiKey: string,
  predictionId: string,
  label: AtlasRunOpts['label'],
): Promise<AtlasPredictionResponse> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const res = await fetch(`${ATLAS_BASE}/prediction/${encodeURIComponent(predictionId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      if (res.status === 429) continue;
      throw new Error(`[atlas-images ${label}] poll failed: ${res.status}`);
    }

    let data: AtlasPredictionResponse;
    try {
      data = (await res.json()) as AtlasPredictionResponse;
    } catch {
      // Transient bad response — keep polling.
      continue;
    }

    if (data.status === 'completed' || data.status === 'succeeded') {
      return data;
    }
    if (data.status === 'failed') {
      throw new Error(
        `[atlas-images ${label}] prediction ${predictionId} failed: ${data.error ?? '(no error message)'}`,
      );
    }
    // 'processing' — keep polling.
  }
  throw new Error(`[atlas-images ${label}] prediction ${predictionId} timed out after 285 s`);
}

/**
 * Best-effort error decoder for Atlas non-2xx responses. Strips HTML
 * gateway pages (CloudFront / WAF) so the toast shows something usable
 * instead of a wall of HTML, and surfaces Atlas's JSON `error` field
 * when present.
 */
async function atlasErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return `[atlas-images] vendor temporarily unavailable (${res.status}) — please try again in a moment`;
    }
    return `[atlas-images] unexpected gateway response (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return `[atlas-images] ${err}`;
    const msg = json.message;
    if (typeof msg === 'string') return `[atlas-images] ${msg}`;
  } catch {
    /* not JSON */
  }
  return `[atlas-images] error ${res.status}: ${text.slice(0, 200)}`;
}
