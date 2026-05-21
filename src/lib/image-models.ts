// Client-safe image-model registry for production-doc per-row image generation.
//
// Used by surfaces that turn a text prompt into an image. Two providers:
//   - `kie`           → Kie.ai cloud, per-image cost (existing default)
//   - `comfyui-local` → ComfyUI on the user's PC, $0 per image, requires
//                       LOCAL_STUDIO=1 in dev (Phase 4 of the local-broll
//                       plan). Routes return 503 if the env flag is missing.
//
// The thumbnails page has its own registry that also covers image-to-image
// variants — keep this one focused on per-row generation.

export type ImageModelProvider = 'kie' | 'comfyui-local';

export interface ImageModelSpec {
  /** Stable id used in URLs / API bodies / localStorage. */
  value: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Where the generation runs. Defaults to 'kie' (back-compat). */
  provider?: ImageModelProvider;
  /** Underlying Kie.ai `model` string sent to /api/v1/jobs/createTask.
   *  Required for `provider: 'kie'`, ignored otherwise. */
  kieModel?: string;
  /** Workflow id in src/lib/comfyui/workflows/ — `provider: 'comfyui-local'`
   *  only. The /api/generate/production-doc/image dispatch reads this. */
  localWorkflowId?: 'flux-schnell-t2i' | 'hidream-i1-dev-t2i' | 'qwen-image-t2i';
  /** One-line hint shown in the picker. */
  hint?: string;
  // ─── v2 image-to-image fields (Phase 0 spike landed 2026-05-21) ──────────
  /** Name of the input field carrying reference image URLs. Set only
   *  on i2i variants — text-to-image specs leave this undefined. Field
   *  name varies by provider per docs.kie.ai (verified 2026-05-21):
   *    - NanoBanana Pro:   `image_input` (array)
   *    - Flux 2 Pro i2i / GPT Image 2 i2i: `input_urls` (array)
   *    - Ideogram Remix:   `image_url` (single URL string) — currently dropped. */
  i2iRefsField?: 'image_input' | 'input_urls' | 'image_url';
  /** Max reference images this i2i variant accepts. Caller code clamps
   *  the user-provided ref count to this value. v1 also enforces a
   *  global ceiling of 8 in production-doc-styles-refs.ts. */
  i2iMaxRefs?: number;
  /** Extra input fields appended to the Kie createTask `input` object
   *  beyond `prompt` + the refs field. Verified per-model against
   *  docs.kie.ai during the Phase 0 spike — many documented-as-accepted
   *  fields actually 500 in practice (NanoBanana Pro: stripping
   *  `output_format` + `resolution` was required). Empty object = no
   *  extras. */
  i2iExtraInput?: Record<string, unknown>;
}

export const IMAGE_MODELS: ImageModelSpec[] = [
  // ─── Cloud i2i (ref-bearing user-defined styles, v2) ──────────────────────
  // Spec-verified against docs.kie.ai 2026-05-21 + empirically tested by
  // the Phase 0 doodle spike (scripts/style-spike.ts). NanoBanana Pro
  // won on a speed tiebreaker after visual tie with GPT Image 2 (~90s
  // vs ~170s/image). Flux 2 Pro i2i is fastest but visually weakest on
  // the doodle aesthetic. See
  // `_plans/2026-05-21-user-defined-styles-with-reference-images.md`.
  {
    value: 'nano-banana-pro-i2i',
    label: 'Reference-driven (NanoBanana Pro)',
    provider: 'kie',
    kieModel: 'nano-banana-pro',
    i2iRefsField: 'image_input',
    i2iMaxRefs: 8,
    // Only aspect_ratio is safe — `output_format` and `resolution` 500
    // the Kie endpoint despite being in the docs (Phase 0 finding).
    i2iExtraInput: { aspect_ratio: '16:9' },
    hint: 'Default for ref-bearing styles. ~90s/image, up to 8 references.',
  },
  {
    value: 'gpt-image-2-i2i',
    label: 'Reference-driven (GPT Image 2)',
    provider: 'kie',
    kieModel: 'gpt-image-2-image-to-image',
    i2iRefsField: 'input_urls',
    i2iMaxRefs: 16,
    i2iExtraInput: { aspect_ratio: '16:9', resolution: '1K' },
    hint: 'Tied visually with NanoBanana, ~2× slower. Up to 16 references.',
  },
  {
    value: 'flux2-pro-i2i',
    label: 'Reference-driven (Flux 2 Pro)',
    provider: 'kie',
    kieModel: 'flux-2/pro-image-to-image',
    i2iRefsField: 'input_urls',
    i2iMaxRefs: 8,
    i2iExtraInput: { aspect_ratio: '16:9', resolution: '1K' },
    hint: 'Fastest (~35s) but visually weakest on doodle styles.',
  },
  // ─── Local (ComfyUI on your PC, $0 per image) ─────────────────────────────
  // Only useful when LOCAL_STUDIO=1; the dispatch route returns 503 in
  // production where the flag is unset. Same models as /local-studio.
  {
    value: 'flux-schnell-local',
    label: 'Flux schnell — Local (free)',
    provider: 'comfyui-local',
    localWorkflowId: 'flux-schnell-t2i',
    hint: 'Local — ~8s warm. Apache 2.0 (commercial OK).',
  },
  {
    value: 'hidream-i1-local',
    label: 'HiDream-I1 — Local (needs 24 GB VRAM)',
    provider: 'comfyui-local',
    localWorkflowId: 'hidream-i1-dev-t2i',
    // Workflow is correct as of 2026-05-22 (Q4_K_M UNet +
    // Q5_K_M GGUF t5xxl — the earlier fp8 t5 erred out with
    // "Mixing scaled FP8 with GGUF is not supported"). But the
    // 4 text encoders + 10.7 GB UNet + sampling activations exceed
    // 16 GB; verified hang at KSampler on RTX 5070 Ti (15 min, zero
    // node progress). Kept in the picker so 24+ GB users can pick it;
    // labelled so 16 GB users know to choose Qwen-Image / Flux schnell.
    hint: 'Premium 28 steps, MIT. Verified to NEED 24+ GB VRAM — hangs on 16 GB cards.',
  },
  {
    value: 'qwen-image-local',
    label: 'Qwen-Image — Local (free)',
    provider: 'comfyui-local',
    localWorkflowId: 'qwen-image-t2i',
    hint: 'Local — best for typography. Apache 2.0 (commercial OK).',
  },
  // ─── Kie.ai cloud (text-to-image) ─────────────────────────────────────────
  { value: 'grok-imagine-t2i', label: 'Grok Imagine', provider: 'kie', kieModel: 'grok-imagine/text-to-image', hint: 'Default — fast, broad style range' },
  { value: 'flux2-pro-t2i', label: 'Flux 2 Pro', provider: 'kie', kieModel: 'flux-2/pro-text-to-image', hint: 'Highest fidelity — slower, costlier' },
  { value: 'flux2-flex-t2i', label: 'Flux 2 Flex', provider: 'kie', kieModel: 'flux-2/flex-text-to-image', hint: 'Flux 2 — balanced cost/quality' },
  { value: 'nano-banana', label: 'Google NanoBanana', provider: 'kie', kieModel: 'google/nano-banana', hint: 'Google Imagen via Kie.ai' },
  { value: 'gpt-image-2-t2i', label: 'GPT Image 2', provider: 'kie', kieModel: 'gpt-image-2-text-to-image', hint: 'OpenAI image model via Kie.ai' },
  // Ideogram v3 — best-in-class for rendering legible text inside the image
  // (signage, posters, hand-lettered captions). Caveat for the production-doc
  // flow: any text Ideogram renders will be warped by the downstream i2v
  // step if the row gets animated. Useful for still-only rows or when the
  // on-screen-text directive is the whole point of the scene.
  //
  // All three tiers share one model string (`ideogram/v3-text-to-image`); the
  // tier is the `rendering_speed` field, set in buildKieImageInput. Two tiers
  // exposed here (Quality + Turbo); the middle "Balanced" tier sits close
  // enough to Quality that adding it bloats the picker without adding choice.
  { value: 'ideogram-v3-quality-t2i', label: 'Ideogram v3 Quality', provider: 'kie', kieModel: 'ideogram/v3-text-to-image', hint: 'Best-in-class text rendering — $0.05/image' },
  { value: 'ideogram-v3-turbo-t2i', label: 'Ideogram v3 Turbo', provider: 'kie', kieModel: 'ideogram/v3-text-to-image', hint: 'Cheap, fast text rendering — $0.0175/image' },
];

/** Default model for the production-doc image generator. Explicit value
 *  (not `IMAGE_MODELS[0].value`) because IMAGE_MODELS[0] is now a cloud
 *  i2i model — defaulting prod users to a ref-required flow would break
 *  rows without a style attached. Stays on Grok Imagine, the prior default. */
export const DEFAULT_IMAGE_MODEL = 'grok-imagine-t2i';

/** Default cloud i2i model — picked by the Phase 0 doodle spike
 *  (scripts/style-spike.ts). NanoBanana Pro won on a speed tiebreaker
 *  after visual tie with GPT Image 2. */
export const DEFAULT_CLOUD_I2I_MODEL = 'nano-banana-pro-i2i';

/** All i2i model `value` ids, derived from `IMAGE_MODELS` so the styles
 *  validator stays in sync automatically when new i2i variants land. */
export const I2I_MODEL_VALUES: readonly string[] = IMAGE_MODELS
  .filter(m => typeof m.i2iMaxRefs === 'number' && m.i2iMaxRefs > 0)
  .map(m => m.value);

export function getImageModelSpec(value: string): ImageModelSpec | undefined {
  return IMAGE_MODELS.find(m => m.value === value);
}

/** Build the per-model `input` payload for Kie.ai's createTask call.
 *  Centralised so client + server agree on which fields each model family needs.
 *  Always 16:9 — the production doc renders at video aspect.
 *
 *  Throws if called for a non-kie model — caller is expected to dispatch
 *  on `spec.provider` BEFORE reaching this function. */
export function buildKieImageInput(modelValue: string, prompt: string): Record<string, unknown> {
  const spec = getImageModelSpec(modelValue);
  if (!spec || spec.provider === 'comfyui-local' || !spec.kieModel) {
    throw new Error(`buildKieImageInput called for non-Kie model '${modelValue}'`);
  }
  const kieModel = spec.kieModel;
  const input: Record<string, unknown> = { prompt };

  // GPT Image 2 and Ideogram v3 don't document an nsfw_checker field;
  // sending it can 422 on stricter validators.
  if (!kieModel.startsWith('gpt-image-2') && !kieModel.startsWith('ideogram/')) {
    input.nsfw_checker = true;
  }

  if (kieModel.startsWith('flux-2')) {
    input.aspect_ratio = '16:9';
    input.resolution = '1K';
  } else if (kieModel.startsWith('google/')) {
    input.image_size = '16:9';
    input.output_format = 'png';
  } else if (kieModel.startsWith('gpt-image-2')) {
    input.aspect_ratio = '16:9';
    input.resolution = '1K';
  } else if (kieModel === 'ideogram/v3-text-to-image') {
    // Ideogram uses enum names for aspect (not "16:9") and routes the
    // tier through the rendering_speed field — all three tiers share
    // the single `ideogram/v3-text-to-image` model string, so the
    // speed is encoded in the spec value.
    input.image_size = 'landscape_16_9';
    input.rendering_speed = modelValue.includes('turbo')
      ? 'TURBO'
      : modelValue.includes('balanced')
        ? 'BALANCED'
        : 'QUALITY';
  } else {
    input.aspect_ratio = '16:9';
  }
  return input;
}

/** Build the per-model `input` payload for Kie.ai's createTask call on an
 *  i2i model. Mirrors `buildKieImageInput` but adds the reference-image
 *  field (name and shape vary by model — see `i2iRefsField`) plus the
 *  per-model `i2iExtraInput` overrides.
 *
 *  - For models with a single-ref `image_url` field (Ideogram Remix), only
 *    the first URL is used.
 *  - For array-ref models (`image_input` / `input_urls`), the list is
 *    capped to `i2iMaxRefs`.
 *
 *  Throws if called for a non-Kie spec or one that isn't marked as i2i. */
export function buildKieI2IInput(
  modelValue: string,
  prompt: string,
  refUrls: readonly string[],
): Record<string, unknown> {
  const spec = getImageModelSpec(modelValue);
  if (!spec || spec.provider !== 'kie' || !spec.kieModel) {
    throw new Error(`buildKieI2IInput called for non-Kie model '${modelValue}'`);
  }
  if (!spec.i2iRefsField) {
    throw new Error(`buildKieI2IInput called for non-i2i model '${modelValue}'`);
  }
  const refs = refUrls.filter(u => typeof u === 'string' && u.trim().length > 0);
  if (refs.length === 0) {
    throw new Error(`buildKieI2IInput called with zero reference URLs`);
  }
  const cap = typeof spec.i2iMaxRefs === 'number' ? Math.max(1, spec.i2iMaxRefs) : refs.length;
  const capped = refs.slice(0, cap);

  const input: Record<string, unknown> = { prompt, ...(spec.i2iExtraInput ?? {}) };
  if (spec.i2iRefsField === 'image_url') {
    input.image_url = capped[0];
  } else {
    input[spec.i2iRefsField] = capped;
  }
  return input;
}
