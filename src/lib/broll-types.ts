/**
 * Client-safe B-roll types + the model registry. Mirrors the shorts-types /
 * dubbing-languages split: the orchestrator in `src/lib/broll.ts` pulls in
 * server-only modules (next/headers via ai.ts, @vercel/blob, etc.), so the
 * row shape and the user-pickable model list live here for client components
 * to import without dragging the whole pipeline into the browser bundle.
 */

/** Database row shape — mirrors the columns in migration 0023's `broll_clips`. */
export interface BrollClipRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  row_signature: string | null;
  row_index: number | null;
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

/** A model the user can pick from the per-row picker. The `kieModel` is the
 *  exact identifier the Kie `createTask` API expects. The `defaultDuration`
 *  is the fallback when the row's prompt doesn't imply a length. Every model
 *  declared here MUST be a video-output model — image models belong in the
 *  existing prodoc-image route. */
export interface BrollModelDescriptor {
  id: string;
  label: string;
  provider: 'kie';
  kieModel: string;
  defaultDurationSeconds: number;
  supportedAspects: ReadonlyArray<'16:9' | '9:16' | '1:1'>;
  /** Short blurb shown in the picker — kept under ~80 chars. */
  blurb: string;
  /** True when the model emits cinematic/photoreal output suitable for the
   *  default "B-roll" use case. Picker uses this to surface a recommended
   *  default when the row doesn't pre-select. */
  recommended?: boolean;
}

/**
 * The picker contents. Order = display order in the UI. Kept as a flat readonly
 * tuple so `BrollModelId` infers a precise union, not just `string`.
 *
 * Sora 2 is the recommended default — ChatGPT-trained video model with the
 * widest motion vocabulary in May 2026. Veo 3 (fast) is the budget alternate
 * with strong photoreal landscapes; Veo 3 (quality) is the slow + expensive
 * option for hero shots.
 */
export const BROLL_MODELS: readonly BrollModelDescriptor[] = [
  {
    id: 'sora-2',
    label: 'Sora 2',
    provider: 'kie',
    kieModel: 'sora-2/text-to-video',
    defaultDurationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    blurb: 'OpenAI Sora 2 — best all-rounder for cinematic B-roll',
    recommended: true,
  },
  {
    id: 'veo-3-fast',
    label: 'Veo 3 (Fast)',
    provider: 'kie',
    kieModel: 'veo3/fast/text-to-video',
    defaultDurationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    blurb: 'Google Veo 3 Fast — cheapest, strong on photoreal landscapes',
  },
  {
    id: 'veo-3-quality',
    label: 'Veo 3 (Quality)',
    provider: 'kie',
    kieModel: 'veo3/quality/text-to-video',
    defaultDurationSeconds: 8,
    supportedAspects: ['16:9', '9:16'],
    blurb: 'Google Veo 3 Quality — slow + pricey, for hero shots only',
  },
];

/** Stable string id of a registered model. Kept as `string` so the picker can
 *  render dynamically — runtime validation lives in `findBrollModel`. */
export type BrollModelId = string;

/** Default model when the caller didn't specify one. */
export const DEFAULT_BROLL_MODEL_ID = 'sora-2';

/** Hard ceiling on prompt length. Kie rejects > ~1500 chars across image and
 *  video endpoints; we apply a slightly tighter bound so we have headroom for
 *  the duration / aspect prefix the orchestrator prepends. */
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
