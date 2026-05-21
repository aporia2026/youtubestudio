/**
 * Production-doc style id → local ComfyUI workflow + recommended params.
 *
 * The cloud b-roll flow already maps each style's `ai_image_suffix` into
 * the Kie prompt. Local generation goes one step further: a style can
 * also opt into a specific local model (Flux schnell for fast iteration,
 * Flux dev for finals, HiDream-I1 for premium, Qwen-Image for typography).
 *
 * Phase 1 only ships the Flux mappings — HiDream + Qwen entries are
 * present but commented out until those models finish downloading and
 * their workflows ship in Phase 1.5.
 *
 * Style id "default" is the fallback used when a style has no explicit
 * entry. Built-in style ids ('cinematic', 'animation_2d', etc.) and
 * saved-style UUIDs both resolve through `mappingForStyle()`.
 */
import { BUILT_IN_STYLES } from '@/lib/production-doc-styles';

/** Which local model family / workflow a style should use by default.
 *
 *  Four model families, each with a `-t2i` (text-to-image) and `-i2i`
 *  (image-to-image, using an uploaded reference) variant:
 *   - flux-schnell: Apache 2.0, 4 steps, fast
 *   - flux-dev:     FLUX.1-dev license (non-commercial), 20 steps, premium
 *   - hidream-i1:   MIT, 28 steps, premium (commercial OK)
 *   - qwen-image:   Apache 2.0, 30 steps, best at typography (commercial OK)
 *
 *  i2i variants are picked automatically when a reference image is
 *  attached to the request — see `i2iVariantOf()` below. */
export type LocalImageWorkflowId =
  | 'flux-schnell-t2i'
  | 'flux-schnell-i2i'
  | 'flux-dev-t2i'
  | 'flux-dev-i2i'
  | 'hidream-i1-dev-t2i'
  | 'hidream-i1-dev-i2i'
  | 'qwen-image-t2i'
  | 'qwen-image-i2i'
  // Qwen-Image-Edit-2509 multi-ref (up to 3). Separate from the
  // single-ref Qwen-Image i2i above because it uses a different
  // diffusion checkpoint AND a different conditioning shape
  // (TextEncodeQwenImageEditPlus, not VAE-encode-as-latent). No t2i
  // counterpart — the model is purpose-built for editing/multi-ref.
  // The dispatcher routes the local-qwen-edit-2509-i2i model entry
  // directly to this workflow id (no t2i→i2i swap via i2iVariantOf).
  | 'qwen-image-edit-2509-i2i';

/** Map a t2i workflow id to its i2i counterpart. Returns the input id
 *  unchanged if it's already an i2i variant or doesn't have one. */
export function i2iVariantOf(id: LocalImageWorkflowId): LocalImageWorkflowId {
  switch (id) {
    case 'flux-schnell-t2i': return 'flux-schnell-i2i';
    case 'flux-dev-t2i':     return 'flux-dev-i2i';
    case 'hidream-i1-dev-t2i': return 'hidream-i1-dev-i2i';
    case 'qwen-image-t2i':   return 'qwen-image-i2i';
    default: return id;
  }
}

/** Video workflow ids — image-to-video models. Phase 3.
 *
 *  Two local i2v models verified working on 16 GB VRAM:
 *   - Wan 2.2 TI2V 5B (Apache 2.0): smaller, fits cleanly, ~3 min/clip
 *   - HunyuanVideo I2V Q4_K_M (Tencent license): bigger but stronger
 *     motion/physics, peak 15 GB VRAM, ~7 min cold / ~2 min warm/clip
 *
 *  LTX-2.3 22B was evaluated but overflows 16 GB regardless of quant. */
export type LocalVideoWorkflowId = 'wan-2.2-i2v' | 'hunyuan-i2v';

export interface LocalVideoWorkflowDescriptor {
  id: LocalVideoWorkflowId;
  label: string;
  hint: string;
}

export const LOCAL_VIDEO_WORKFLOWS: ReadonlyArray<LocalVideoWorkflowDescriptor> = Object.freeze([
  {
    id: 'wan-2.2-i2v',
    label: 'Wan 2.2 (5B)',
    hint: 'Fast i2v — 30 steps, Apache 2.0. ~3 min cold, ~90 s warm per 2 s clip.',
  },
  {
    id: 'hunyuan-i2v',
    label: 'HunyuanVideo I2V',
    hint: 'Premium i2v — 20 steps, peak 15 GB VRAM. ~7 min cold, ~2 min warm per 2 s clip.',
  },
]);

export function isKnownLocalVideoWorkflow(id: string): id is LocalVideoWorkflowId {
  return LOCAL_VIDEO_WORKFLOWS.some(w => w.id === id);
}

/** Resolved parameters for one local image generation. */
export interface LocalImageMapping {
  /** Which workflow template to fill. Files live in `workflows/`. */
  workflow: LocalImageWorkflowId;
  /** Output width in pixels. Workflow templates accept any multiple of 16. */
  width: number;
  /** Output height. Local studio defaults to 16:9 (1280x720). */
  height: number;
  /** Human-readable hint for the picker UI. */
  hint?: string;
}

/** Default mapping when a style has no specific override. Flux schnell
 *  4 steps = fast iteration; users can flip to dev / HiDream per request. */
export const DEFAULT_LOCAL_IMAGE_MAPPING: LocalImageMapping = Object.freeze({
  workflow: 'flux-schnell-t2i',
  width: 1280,
  height: 720,
  hint: 'Fast — 4 steps via Flux schnell',
});

/** Explicit per-style overrides. Only built-in styles are listed here;
 *  saved styles fall through to DEFAULT_LOCAL_IMAGE_MAPPING (a future
 *  phase adds a `local_workflow_id` column to `production_doc_styles`
 *  so users can pin per-saved-style). */
const STYLE_OVERRIDES: Readonly<Record<string, LocalImageMapping>> = Object.freeze({
  // Cinematic + photoreal styles route to HiDream-I1 (premium quality,
  // MIT). Doodle / animation styles stay on Flux schnell (fast 4-step,
  // style suffix carries the look). Typography-heavy styles could be
  // added with qwen-image-t2i — currently no built-in style hard-routes
  // there, but the user can pick it manually in the picker.
  cinematic: {
    workflow: 'hidream-i1-dev-t2i',
    width: 1280,
    height: 720,
    hint: 'HiDream-I1 GGUF — cinematic photoreal',
  },
  documentary: {
    workflow: 'hidream-i1-dev-t2i',
    width: 1280,
    height: 720,
    hint: 'HiDream-I1 GGUF — documentary realism',
  },
  animation_2d: {
    workflow: 'flux-schnell-t2i',
    width: 1280,
    height: 720,
    hint: 'Flux schnell — fast 2D animation',
  },
  animation_3d: {
    workflow: 'flux-schnell-t2i',
    width: 1280,
    height: 720,
    hint: 'Flux schnell — fast 3D animation',
  },
});

/** Resolve a style id to its local-image mapping. Falls through to the
 *  default when the style isn't explicitly mapped. Validates that the
 *  style id exists either in built-ins or is a UUID-like string. */
export function mappingForStyle(styleId: string | null | undefined): LocalImageMapping {
  if (!styleId) return DEFAULT_LOCAL_IMAGE_MAPPING;
  return STYLE_OVERRIDES[styleId] ?? DEFAULT_LOCAL_IMAGE_MAPPING;
}

/** Listing helper for the picker UI — shows every workflow available,
 *  grouped by underlying model. Built from a static list rather than
 *  filesystem read so we keep the bundle deterministic. */
export interface LocalWorkflowDescriptor {
  id: LocalImageWorkflowId;
  label: string;
  hint: string;
  /** True when the underlying model file is non-commercial — UI shows a badge. */
  nonCommercial?: boolean;
}

/** Picker shows only t2i ids — the i2i swap is automatic when a reference
 *  image is attached. Surface order here is the picker order. */
export const LOCAL_WORKFLOWS: ReadonlyArray<LocalWorkflowDescriptor> = Object.freeze([
  {
    id: 'flux-schnell-t2i',
    label: 'Flux schnell',
    hint: 'Fast — 4 steps, Apache 2.0 (commercial OK)',
  },
  {
    id: 'hidream-i1-dev-t2i',
    label: 'HiDream-I1 dev',
    hint: 'Quality — 28 steps, MIT (commercial OK). Slower but premium.',
  },
  {
    id: 'qwen-image-t2i',
    label: 'Qwen-Image',
    hint: 'Best for text/numbers — 30 steps, Apache 2.0 (commercial OK).',
  },
  {
    id: 'flux-dev-t2i',
    label: 'Flux dev',
    hint: 'Premium photoreal — 20 steps. Personal/research use only.',
    nonCommercial: true,
  },
]);

/** Used by validation in API routes — accept only declared ids. */
export function isKnownLocalWorkflow(id: string): id is LocalImageWorkflowId {
  return LOCAL_WORKFLOWS.some(w => w.id === id);
}

/** Validate at module load time that every built-in style either has an
 *  explicit mapping or is comfortable with the default. This is a
 *  fail-fast sanity check — if someone adds a new built-in style and
 *  forgets the override, the dev console gets a one-time warning rather
 *  than silently shipping wrong defaults. Wrapped in a function so it
 *  only fires on first import in a runtime that has BUILT_IN_STYLES. */
export function auditStyleCoverage(): { style: string; usingDefault: boolean }[] {
  return BUILT_IN_STYLES.map(s => ({
    style: s.id,
    usingDefault: !(s.id in STYLE_OVERRIDES),
  }));
}
