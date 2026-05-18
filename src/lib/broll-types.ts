/**
 * Client-safe B-roll types + the model registry. Mirrors the shorts-types /
 * dubbing-languages split: the orchestrator in `src/lib/broll.ts` pulls in
 * server-only modules (next/headers via ai.ts, @vercel/blob, etc.), so the
 * row shape and the user-pickable model list live here for client components
 * to import without dragging the whole pipeline into the browser bundle.
 *
 * Two model families:
 *
 *   text-to-video (t2v)  — Sora 2 / Veo 3 / Kling t2v. Prompt-only input.
 *                          Used for cinematic B-Roll rows where the row has
 *                          no reference still or the still doesn't matter.
 *
 *   image-to-video (i2v) — Kling 2.5 turbo Pro / Kling 2.6 / Sora 2 i2v.
 *                          Takes the row's already-generated still as the
 *                          first frame and animates it. Preserves the
 *                          row's chosen visual style (doodle, 2D, etc.)
 *                          instead of forcing it into photoreal output.
 *                          REQUIRES a still image URL — the picker UI
 *                          disables i2v models on rows without one.
 *
 * The per-model `buildBody()` function encodes Kie's wire shape — most
 * models post to `/api/v1/jobs/createTask` with a `{ model, input }` body,
 * but the field name for the image varies (`image_url` singular vs
 * `image_urls` array vs `imageUrl` camelCase) and the duration field is
 * inconsistent (string enum "5" / "10" vs integer seconds). Centralising
 * the per-model body here keeps the wire layer in `src/lib/broll.ts` model-agnostic.
 */

/** Database row shape — mirrors the columns in migration 0023's `broll_clips`. */
export interface BrollClipRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  row_signature: string | null;
  row_index: number | null;
  /** Production-doc history entry id the clip was generated for. Added by
   *  migration 0072 — NULL on legacy rows and on clips generated for an
   *  unsaved doc. See plan `_plans/2026-05-17-broll-doc-id-hydration.md`. */
  production_doc_id: string | null;
  prompt: string;
  model_id: string;
  provider: string;
  aspect_ratio: string;
  duration_seconds: number | null;
  status: BrollStatus;
  task_id: string | null;
  error_message: string | null;
  video_url: string | null;
  blob_pathname: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type BrollStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** Whether the model accepts a reference image as its first frame. */
export type BrollModelKind = 'text-to-video' | 'image-to-video';

/** Provider/architecture family — used by the picker UI to group entries
 *  under subheadings (Kling, Sora, Veo, Runway, Grok, Seedance) so a 25+
 *  model list scans like a menu instead of a flat dump. New families
 *  are appended; the picker iterates `BROLL_FAMILY_ORDER` to render
 *  groups in a stable order. */
export type BrollFamily = 'kling' | 'sora' | 'veo' | 'runway' | 'grok' | 'seedance';

/** Display order for picker family subheadings. Picker UI iterates this
 *  array and renders one group per family, skipping families with no
 *  entries. */
export const BROLL_FAMILY_ORDER: ReadonlyArray<BrollFamily> = [
  'kling',
  'sora',
  'veo',
  'runway',
  'grok',
  'seedance',
];

/** Human label per family — picker subheading text. */
export const BROLL_FAMILY_LABEL: Readonly<Record<BrollFamily, string>> = Object.freeze({
  kling: 'Kling',
  sora: 'Sora',
  veo: 'Google Veo',
  runway: 'Runway',
  grok: 'Grok Imagine',
  seedance: 'ByteDance Seedance',
});

/** Arguments passed into the per-model body builder. The orchestrator
 *  pre-validates the inputs the model actually needs — `stillImageUrl`
 *  is guaranteed non-empty for `kind: 'image-to-video'`. */
export interface BuildBrollBodyArgs {
  prompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds: number;
  stillImageUrl?: string;
  callbackUrl?: string;
}

/** A model the user can pick from the per-row picker. */
export interface BrollModelDescriptor {
  id: string;
  label: string;
  kind: BrollModelKind;
  family: BrollFamily;
  provider: 'kie';
  /** Display-only USD price quoted from the Kie pricing page. NEVER used
   *  to bill; just shown in the picker so the user sees cost-per-click. */
  priceUsdLabel: string;
  /** Approximate price as a number for sorting / budget displays. */
  priceUsd: number;
  /** Generation duration in seconds (5 or 10 for most i2v models). */
  durationSeconds: number;
  supportedAspects: ReadonlyArray<'16:9' | '9:16' | '1:1'>;
  /** Kie endpoint path. Most models use `/jobs/createTask`; Runway has
   *  `/runway/generate`; Veo 3.1 has `/veo/generate` with its own status
   *  polling shape. The wire layer in `src/lib/broll.ts` resolves this
   *  to a full URL and matches the status response shape to the endpoint. */
  endpoint: 'createTask' | 'runway-generate' | 'veo-generate';
  /** Short blurb shown in the picker. Kept under ~80 chars. */
  blurb: string;
  /** True when this model is the suggested default for its kind. The
   *  registry-level `DEFAULT_BROLL_MODEL_ID` overrides this; this flag
   *  only matters for picker decorations. */
  recommended?: boolean;
  /** Build the full request body Kie expects for this model. */
  buildBody: (args: BuildBrollBodyArgs) => Record<string, unknown>;
}

// ─── Body builders ──────────────────────────────────────────────────────────
//
// Kept as top-level functions so the descriptor objects can stay shallow
// (and so unit tests can target each shape independently).

// Kling (and most i2v models) hallucinate gibberish text into animated
// scenes — random letters appear floating in the frame even when the
// source still has no text. The fix is an explicit `negative_prompt`
// telling the model what NOT to generate. Kling 2.5/2.6 both honour
// this field per Kie's documented schema. We send it on every call;
// users haven't asked for text-in-animation, and if they ever do we
// can expose a per-row override.
const NO_TEXT_NEGATIVE_PROMPT =
  'text, writing, letters, words, labels, captions, watermarks, signage, characters, typography, fonts, numbers, subtitles';

function buildKlingV25TurboI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'kling/v2-5-turbo-image-to-video-pro',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      image_url: args.stillImageUrl,
      duration: String(args.durationSeconds) as '5' | '10',
      negative_prompt: NO_TEXT_NEGATIVE_PROMPT,
    },
  };
}

function buildKlingV25TurboT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'kling/v2-5-turbo-text-to-video-pro',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration: String(args.durationSeconds) as '5' | '10',
      negative_prompt: NO_TEXT_NEGATIVE_PROMPT,
    },
  };
}

function buildKling26I2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'kling-2.6/image-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      image_urls: args.stillImageUrl ? [args.stillImageUrl] : [],
      sound: false,
      duration: String(args.durationSeconds) as '5' | '10',
      negative_prompt: NO_TEXT_NEGATIVE_PROMPT,
    },
  };
}

function buildSora2I2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  // Sora 2 i2v expresses orientation as `landscape` / `portrait`, not 16:9 / 9:16.
  const orientation = args.aspectRatio === '9:16' ? 'portrait' : 'landscape';
  // `n_frames` is a duration tier per the Kie docs ("10" or "15"). Pick the
  // tier closest to the caller's requested durationSeconds.
  const tier: '10' | '15' = args.durationSeconds >= 13 ? '15' : '10';
  return {
    model: 'sora-2-image-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      image_urls: args.stillImageUrl ? [args.stillImageUrl] : [],
      aspect_ratio: orientation,
      n_frames: tier,
    },
  };
}

function buildSora2T2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'sora-2/text-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration: args.durationSeconds,
    },
  };
}

function buildVeo3FastT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'veo3/fast/text-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration: args.durationSeconds,
    },
  };
}

function buildVeo3QualityT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'veo3/quality/text-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration: args.durationSeconds,
    },
  };
}

// ─── Grok Imagine i2v ───────────────────────────────────────────────────────
// xAI's Grok Imagine — accepts a still + prompt and returns an animated clip.
// Cheapest tier in the i2v lineup at $0.015/sec (720p). Uses Kie's unified
// `/jobs/createTask` endpoint. Image is passed as an array of URLs (max 7,
// we only ever send one). `mode: 'normal'` is the safe default; 'spicy' is
// unavailable for external image URLs per Kie's docs.
function buildGrokImagineI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'grok-imagine/image-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      image_urls: args.stillImageUrl ? [args.stillImageUrl] : [],
      prompt: args.prompt,
      mode: 'normal',
      duration: String(args.durationSeconds),
      resolution: '720p',
      aspect_ratio: args.aspectRatio,
      nsfw_checker: false,
    },
  };
}

// ─── Veo 3.1 family ─────────────────────────────────────────────────────────
// Veo 3.1 uses a DIFFERENT endpoint than Veo 3 (`/api/v1/veo/generate` instead
// of `/api/v1/jobs/createTask`) and a different status-polling response shape.
// The wire layer dispatches on `endpoint: 'veo-generate'`.
//
// Three quality tiers — Lite ($0.15/video), Fast ($0.30/video), Quality
// ($1.25/video) — and two generation modes:
//   - TEXT_2_VIDEO         — no reference image, prompt only
//   - REFERENCE_2_VIDEO    — single reference image, only supported on Fast
// (Quality's image-mode is FIRST_AND_LAST_FRAMES_2_VIDEO which needs two
//  images — not exposed here.)
function buildVeo31Body(
  args: BuildBrollBodyArgs,
  modelString: 'veo3_lite' | 'veo3_fast' | 'veo3',
  generationType: 'TEXT_2_VIDEO' | 'REFERENCE_2_VIDEO',
): Record<string, unknown> {
  return {
    model: modelString,
    prompt: args.prompt,
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    aspect_ratio: args.aspectRatio === '1:1' ? '16:9' : args.aspectRatio,
    resolution: '720p',
    generationType,
    enableTranslation: false,
    ...(generationType === 'REFERENCE_2_VIDEO' && args.stillImageUrl
      ? { imageUrls: [args.stillImageUrl] }
      : {}),
  };
}

function buildVeo31LiteT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildVeo31Body(args, 'veo3_lite', 'TEXT_2_VIDEO');
}

function buildVeo31FastT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildVeo31Body(args, 'veo3_fast', 'TEXT_2_VIDEO');
}

function buildVeo31FastI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildVeo31Body(args, 'veo3_fast', 'REFERENCE_2_VIDEO');
}

function buildVeo31QualityT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildVeo31Body(args, 'veo3', 'TEXT_2_VIDEO');
}

// ─── Runway ─────────────────────────────────────────────────────────────────
// Kie.ai exposes Runway as a SINGLE endpoint with no `model` parameter —
// the variant is implicit from the duration + quality knobs. So the registry
// holds tier-combination entries (5s/10s × i2v/t2v) rather than model
// variants. Field is `aspectRatio` (camelCase, unlike most other models).
// `aspectRatio` is documented as ignored when `imageUrl` is provided.
function buildRunwayI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    prompt: args.prompt,
    imageUrl: args.stillImageUrl,
    duration: args.durationSeconds <= 5 ? 5 : 10,
    quality: '720p',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
  };
}

function buildRunwayT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    prompt: args.prompt,
    aspectRatio: args.aspectRatio,
    duration: args.durationSeconds <= 5 ? 5 : 10,
    quality: '720p',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
  };
}

// ─── Seedance 2 / 2 Fast (ByteDance) ────────────────────────────────────────
// Seedance 2 and Seedance 2 Fast share an input shape — they differ only in
// model string and pricing. Image-to-video uses `first_frame_url` (single
// still). `generate_audio: false` keeps the per-clip cost on the cheaper
// "no-video-input" tier of kie.ai's pricing matrix (audio output bumps the
// price ~2× on Seedance). Duration units: integer seconds, 4–15.
function buildSeedance2Body(
  args: BuildBrollBodyArgs,
  modelString: 'bytedance/seedance-2' | 'bytedance/seedance-2-fast',
  hasImage: boolean,
): Record<string, unknown> {
  return {
    model: modelString,
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      ...(hasImage && args.stillImageUrl ? { first_frame_url: args.stillImageUrl } : {}),
      resolution: '720p',
      aspect_ratio: args.aspectRatio,
      duration: Math.max(4, Math.min(15, args.durationSeconds)),
      generate_audio: false,
      nsfw_checker: false,
    },
  };
}

function buildSeedance2I2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance2Body(args, 'bytedance/seedance-2', true);
}

function buildSeedance2T2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance2Body(args, 'bytedance/seedance-2', false);
}

function buildSeedance2FastI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance2Body(args, 'bytedance/seedance-2-fast', true);
}

function buildSeedance2FastT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance2Body(args, 'bytedance/seedance-2-fast', false);
}

// ─── Seedance 1.5 Pro ───────────────────────────────────────────────────────
// Older Seedance generation. Different input shape than Seedance 2 — uses
// `input_urls` (array, max 2) for the still and a STRING duration that must
// be one of '4', '8', '12'. The aspect_ratio field is required on this one.
function buildSeedance15ProBody(
  args: BuildBrollBodyArgs,
  hasImage: boolean,
): Record<string, unknown> {
  // Snap to nearest supported tier — Seedance 1.5 Pro only accepts 4 / 8 / 12.
  const supported: ReadonlyArray<4 | 8 | 12> = [4, 8, 12];
  const requested = Math.max(4, Math.min(12, args.durationSeconds));
  const tier = supported.reduce((best, t) =>
    Math.abs(t - requested) < Math.abs(best - requested) ? t : best,
  );
  return {
    model: 'bytedance/seedance-1.5-pro',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      prompt: args.prompt,
      ...(hasImage && args.stillImageUrl ? { input_urls: [args.stillImageUrl] } : {}),
      aspect_ratio: args.aspectRatio,
      resolution: '720p',
      duration: String(tier) as '4' | '8' | '12',
      fixed_lens: false,
      generate_audio: false,
      nsfw_checker: false,
    },
  };
}

function buildSeedance15ProI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance15ProBody(args, true);
}

function buildSeedance15ProT2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return buildSeedance15ProBody(args, false);
}

// ─── Registry ───────────────────────────────────────────────────────────────
//
// Order = display order in the picker. The picker UI groups by `kind` —
// image-to-video first (because it preserves the user's chosen visual style),
// text-to-video below.
export const BROLL_MODELS: readonly BrollModelDescriptor[] = [
  // ─── Image-to-video ─────────────────────────────────────────────────────
  {
    id: 'kling-v2-5-turbo-i2v-pro-10s',
    label: 'Kling 2.5 Turbo (10s)',
    kind: 'image-to-video',
    family: 'kling',
    provider: 'kie',
    priceUsdLabel: '$0.42',
    priceUsd: 0.42,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Best all-rounder for 2D / illustrated / character animation. Default.',
    recommended: true,
    buildBody: buildKlingV25TurboI2VBody,
  },
  {
    id: 'kling-v2-5-turbo-i2v-pro-5s',
    label: 'Kling 2.5 Turbo (5s)',
    kind: 'image-to-video',
    family: 'kling',
    provider: 'kie',
    priceUsdLabel: '$0.21',
    priceUsd: 0.21,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Half-cost short clip — same model as the 10s default.',
    buildBody: buildKlingV25TurboI2VBody,
  },
  {
    id: 'kling-2-6-i2v-10s',
    label: 'Kling 2.6 (10s)',
    kind: 'image-to-video',
    family: 'kling',
    provider: 'kie',
    priceUsdLabel: '$0.55',
    priceUsd: 0.55,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Newer Kling — sharper motion physics, costs slightly more.',
    buildBody: buildKling26I2VBody,
  },
  {
    id: 'kling-2-6-i2v-5s',
    label: 'Kling 2.6 (5s)',
    kind: 'image-to-video',
    family: 'kling',
    provider: 'kie',
    priceUsdLabel: '$0.275',
    priceUsd: 0.275,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Short Kling 2.6 clip — half the cost of the 10s.',
    buildBody: buildKling26I2VBody,
  },
  {
    id: 'sora-2-i2v-10s',
    label: 'Sora 2 i2v (10s)',
    kind: 'image-to-video',
    family: 'sora',
    provider: 'kie',
    // kie.ai Standard tier, verified 2026-05-18 from market page screenshots.
    // Prior label was '~$1.00' — overstated cost by ~6.7×.
    priceUsdLabel: '$0.15',
    priceUsd: 0.15,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'OpenAI Sora 2 i2v. Best for cinematic + photoreal stills.',
    buildBody: buildSora2I2VBody,
  },
  {
    id: 'sora-2-i2v-15s',
    label: 'Sora 2 i2v (15s)',
    kind: 'image-to-video',
    family: 'sora',
    provider: 'kie',
    priceUsdLabel: '$0.175',
    priceUsd: 0.175,
    durationSeconds: 15,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Longer Sora 2 i2v clip — 15s n_frames tier.',
    buildBody: buildSora2I2VBody,
  },
  // ─── Image-to-video (new families) ──────────────────────────────────────
  {
    id: 'grok-imagine-i2v-10s',
    label: 'Grok Imagine (10s, 720p)',
    kind: 'image-to-video',
    family: 'grok',
    provider: 'kie',
    priceUsdLabel: '$0.15',
    priceUsd: 0.15,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'xAI Grok Imagine i2v — tied with Sora 2 as the cheapest tier.',
    buildBody: buildGrokImagineI2VBody,
  },
  {
    id: 'veo-3-1-fast-i2v',
    label: 'Veo 3.1 Fast i2v',
    kind: 'image-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$0.30',
    priceUsd: 0.30,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'veo-generate',
    blurb: 'Veo 3.1 Fast with reference image (REFERENCE_2_VIDEO mode).',
    buildBody: buildVeo31FastI2VBody,
  },
  {
    id: 'runway-i2v-5s-720p',
    label: 'Runway i2v (5s, 720p)',
    kind: 'image-to-video',
    family: 'runway',
    provider: 'kie',
    priceUsdLabel: '$0.06',
    priceUsd: 0.06,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'runway-generate',
    blurb: 'Cheapest i2v in the lineup — Runway short clip.',
    buildBody: buildRunwayI2VBody,
  },
  {
    id: 'runway-i2v-10s-720p',
    label: 'Runway i2v (10s, 720p)',
    kind: 'image-to-video',
    family: 'runway',
    provider: 'kie',
    priceUsdLabel: '$0.15',
    priceUsd: 0.15,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'runway-generate',
    blurb: 'Runway 10s i2v — value-tier longer clip.',
    buildBody: buildRunwayI2VBody,
  },
  {
    id: 'seedance-2-i2v',
    label: 'Seedance 2 i2v (5s, 720p)',
    kind: 'image-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '~$1.03 (5s)',
    priceUsd: 1.025,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'ByteDance Seedance 2 i2v — $0.205/sec, no-video-input tier.',
    buildBody: buildSeedance2I2VBody,
  },
  {
    id: 'seedance-2-fast-i2v',
    label: 'Seedance 2 Fast i2v (5s, 720p)',
    kind: 'image-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '~$0.83 (5s)',
    priceUsd: 0.825,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'Faster Seedance 2 tier — $0.165/sec.',
    buildBody: buildSeedance2FastI2VBody,
  },
  {
    id: 'seedance-1-5-pro-i2v',
    label: 'Seedance 1.5 Pro i2v (8s, 720p)',
    kind: 'image-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '$0.14',
    priceUsd: 0.14,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'Older but cheap — flat $0.14 per 8s 720p clip, no audio.',
    buildBody: buildSeedance15ProI2VBody,
  },
  // ─── Text-to-video ──────────────────────────────────────────────────────
  {
    id: 'kling-v2-5-turbo-t2v-pro-10s',
    label: 'Kling 2.5 Turbo t2v (10s)',
    kind: 'text-to-video',
    family: 'kling',
    provider: 'kie',
    priceUsdLabel: '$0.42',
    priceUsd: 0.42,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'Kling text-to-video for rows without a reference still.',
    buildBody: buildKlingV25TurboT2VBody,
  },
  {
    id: 'sora-2',
    label: 'Sora 2 t2v',
    kind: 'text-to-video',
    family: 'sora',
    provider: 'kie',
    priceUsdLabel: '~$0.80',
    priceUsd: 0.8,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'OpenAI Sora 2 text-to-video — cinematic B-roll.',
    buildBody: buildSora2T2VBody,
  },
  {
    id: 'veo-3-fast',
    label: 'Veo 3 (Fast, legacy)',
    kind: 'text-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$0.40',
    priceUsd: 0.4,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Legacy Veo 3 Fast endpoint — kept for backward compatibility.',
    buildBody: buildVeo3FastT2VBody,
  },
  {
    id: 'veo-3-quality',
    label: 'Veo 3 (Quality, legacy)',
    kind: 'text-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$2.00',
    priceUsd: 2.0,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Legacy Veo 3 Quality endpoint — kept for backward compatibility.',
    buildBody: buildVeo3QualityT2VBody,
  },
  // ─── Text-to-video (new families) ───────────────────────────────────────
  {
    id: 'veo-3-1-lite-t2v',
    label: 'Veo 3.1 Lite t2v',
    kind: 'text-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$0.15',
    priceUsd: 0.15,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'veo-generate',
    blurb: 'Cheapest Veo tier — high-volume budget t2v at 720p.',
    buildBody: buildVeo31LiteT2VBody,
  },
  {
    id: 'veo-3-1-fast-t2v',
    label: 'Veo 3.1 Fast t2v',
    kind: 'text-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$0.30',
    priceUsd: 0.30,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'veo-generate',
    blurb: 'Veo 3.1 Fast — strong quality for the price.',
    buildBody: buildVeo31FastT2VBody,
  },
  {
    id: 'veo-3-1-quality-t2v',
    label: 'Veo 3.1 Quality t2v',
    kind: 'text-to-video',
    family: 'veo',
    provider: 'kie',
    priceUsdLabel: '$1.25',
    priceUsd: 1.25,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'veo-generate',
    blurb: 'Veo 3.1 flagship — hero shots at 720p.',
    buildBody: buildVeo31QualityT2VBody,
  },
  {
    id: 'runway-t2v-5s-720p',
    label: 'Runway t2v (5s, 720p)',
    kind: 'text-to-video',
    family: 'runway',
    provider: 'kie',
    priceUsdLabel: '$0.06',
    priceUsd: 0.06,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'runway-generate',
    blurb: 'Cheapest t2v in the lineup — Runway short clip.',
    buildBody: buildRunwayT2VBody,
  },
  {
    id: 'runway-t2v-10s-720p',
    label: 'Runway t2v (10s, 720p)',
    kind: 'text-to-video',
    family: 'runway',
    provider: 'kie',
    priceUsdLabel: '$0.15',
    priceUsd: 0.15,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'runway-generate',
    blurb: 'Runway 10s t2v — value-tier longer clip.',
    buildBody: buildRunwayT2VBody,
  },
  {
    id: 'seedance-2-t2v',
    label: 'Seedance 2 t2v (5s, 720p)',
    kind: 'text-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '~$1.03 (5s)',
    priceUsd: 1.025,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'ByteDance Seedance 2 t2v — same per-second price as i2v.',
    buildBody: buildSeedance2T2VBody,
  },
  {
    id: 'seedance-2-fast-t2v',
    label: 'Seedance 2 Fast t2v (5s, 720p)',
    kind: 'text-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '~$0.83 (5s)',
    priceUsd: 0.825,
    durationSeconds: 5,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'Faster Seedance 2 t2v tier.',
    buildBody: buildSeedance2FastT2VBody,
  },
  {
    id: 'seedance-1-5-pro-t2v',
    label: 'Seedance 1.5 Pro t2v (8s, 720p)',
    kind: 'text-to-video',
    family: 'seedance',
    provider: 'kie',
    priceUsdLabel: '$0.14',
    priceUsd: 0.14,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16', '1:1'],
    endpoint: 'createTask',
    blurb: 'Older Seedance — flat $0.14 per 8s 720p clip.',
    buildBody: buildSeedance15ProT2VBody,
  },
];

/** Stable string id of a registered model. Kept as `string` so the picker can
 *  render dynamically — runtime validation lives in `findBrollModel`. */
export type BrollModelId = string;

/** Library-level default — used when a user has no `default_broll_model_id`
 *  set on their `collaborators` row. The user's per-account default
 *  overrides this; see `/api/user/preferences/broll-default`. */
export const DEFAULT_BROLL_MODEL_ID = 'kling-v2-5-turbo-i2v-pro-10s';

/**
 * Map from 10s-tier model id → its same-architecture 5s sibling. Used by
 * `pickModelForScene` to auto-downgrade a long-tier choice when the
 * row's scene is short enough that the 5s clip covers the whole scene
 * without losing content. Sora 2 i2v / Veo 3 / Sora 2 t2v have no 5s
 * sibling — passed through unchanged. See plan
 * `_plans/2026-05-17-clip-duration-fit.md`.
 */
const FIVE_SECOND_VARIANT_OF: Readonly<Record<string, string>> = Object.freeze({
  'kling-v2-5-turbo-i2v-pro-10s': 'kling-v2-5-turbo-i2v-pro-5s',
  'kling-2-6-i2v-10s': 'kling-2-6-i2v-5s',
});

/** Threshold (seconds) at or below which we use the 5s tier. Above this,
 *  the 10s tier is used and any extra clip duration freezes on the last
 *  frame — preferred over cutting narration content short. */
const FIVE_SECOND_TIER_THRESHOLD_SECONDS = 5.0;

/**
 * Auto-pick the cheaper 5s tier when the scene fits in 5s. Falls back
 * to the user-picked model when:
 *   - the scene is longer than the threshold (10s tier wins), OR
 *   - the model has no 5s variant (Sora 2 / Veo).
 *
 * Pure function — returns the chosen model id. Doesn't validate that
 * the id exists; the route layer enforces that via `findBrollModel`.
 */
export function pickModelForScene(
  userPickedModelId: string,
  sceneDurationSeconds: number,
): { modelId: string; downgraded: boolean } {
  if (
    Number.isFinite(sceneDurationSeconds) &&
    sceneDurationSeconds <= FIVE_SECOND_TIER_THRESHOLD_SECONDS &&
    FIVE_SECOND_VARIANT_OF[userPickedModelId]
  ) {
    return { modelId: FIVE_SECOND_VARIANT_OF[userPickedModelId], downgraded: true };
  }
  return { modelId: userPickedModelId, downgraded: false };
}

/** Hard cap on prompt length. Kie rejects > ~2500 chars across image and
 *  video endpoints for Kling models; we apply a tighter bound so we have
 *  headroom for the duration / aspect prefix the orchestrator prepends. */
export const BROLL_MAX_PROMPT_CHARS = 1400;

/** Min prompt length — Sora and Veo both produce noise on < ~30 chars. */
export const BROLL_MIN_PROMPT_CHARS = 30;

export function findBrollModel(id: string): BrollModelDescriptor | undefined {
  return BROLL_MODELS.find((m) => m.id === id);
}

/**
 * Stable signature for a Production Doc row — clients hash this client-side
 * with a content hash and pass it to the create endpoint so a regenerated doc
 * can rehydrate clips against rows whose timecode + visual_description still
 * match. Pure helper, intentionally simple: changing the hash here (or the
 * inputs the client passes) invalidates rehydration for already-stored clips,
 * so think twice before editing.
 */
export function brollRowSignatureInput(row: {
  timecode?: string;
  visual_description?: string;
}): string {
  const tc = (row.timecode ?? '').trim();
  const vd = (row.visual_description ?? '').trim().toLowerCase();
  return `${tc}::${vd}`;
}
