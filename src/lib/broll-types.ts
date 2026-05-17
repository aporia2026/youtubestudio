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
  provider: 'kie';
  /** Display-only USD price quoted from the Kie pricing page. NEVER used
   *  to bill; just shown in the picker so the user sees cost-per-click. */
  priceUsdLabel: string;
  /** Approximate price as a number for sorting / budget displays. */
  priceUsd: number;
  /** Generation duration in seconds (5 or 10 for most i2v models). */
  durationSeconds: number;
  supportedAspects: ReadonlyArray<'16:9' | '9:16' | '1:1'>;
  /** Kie endpoint path. Most models use `/createTask`; Runway has its own
   *  endpoint. Stored relative to KIE_BASE so the wire layer concatenates. */
  endpoint: 'createTask' | 'runway-generate';
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
    provider: 'kie',
    priceUsdLabel: '~$1.00',
    priceUsd: 1.0,
    durationSeconds: 10,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'OpenAI Sora 2 i2v. Best for cinematic + photoreal stills.',
    buildBody: buildSora2I2VBody,
  },
  // ─── Text-to-video ──────────────────────────────────────────────────────
  {
    id: 'kling-v2-5-turbo-t2v-pro-10s',
    label: 'Kling 2.5 Turbo t2v (10s)',
    kind: 'text-to-video',
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
    label: 'Veo 3 (Fast)',
    kind: 'text-to-video',
    provider: 'kie',
    priceUsdLabel: '$0.40',
    priceUsd: 0.4,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Google Veo 3 Fast — cheap photoreal landscapes.',
    buildBody: buildVeo3FastT2VBody,
  },
  {
    id: 'veo-3-quality',
    label: 'Veo 3 (Quality)',
    kind: 'text-to-video',
    provider: 'kie',
    priceUsdLabel: '$2.00',
    priceUsd: 2.0,
    durationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    endpoint: 'createTask',
    blurb: 'Google Veo 3 Quality — slow + pricey hero shots.',
    buildBody: buildVeo3QualityT2VBody,
  },
];

/** Stable string id of a registered model. Kept as `string` so the picker can
 *  render dynamically — runtime validation lives in `findBrollModel`. */
export type BrollModelId = string;

/** Library-level default — used when a user has no `default_broll_model_id`
 *  set on their `collaborators` row. The user's per-account default
 *  overrides this; see `/api/user/preferences/broll-default`. */
export const DEFAULT_BROLL_MODEL_ID = 'kling-v2-5-turbo-i2v-pro-10s';

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
