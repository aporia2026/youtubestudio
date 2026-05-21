// Client-safe image-model registry for production-doc per-row image generation.
//
// Used by surfaces that turn a text prompt into an image. Two providers:
//   - `kie`           → Kie.ai cloud, per-image cost (existing default)
//   - `comfyui-local` → ComfyUI on the user's PC, $0 per image, requires
//                       LOCAL_STUDIO=1 in dev (Phase 4 of the local-broll
//                       plan). Routes return 503 if the env flag is missing.
//
// The thumbnails page has its own registry that also covers image-to-image
// variants — keep this one focused on t2i.

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
}

export const IMAGE_MODELS: ImageModelSpec[] = [
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
    label: 'HiDream-I1 — Local (free)',
    provider: 'comfyui-local',
    localWorkflowId: 'hidream-i1-dev-t2i',
    hint: 'Local — premium 28 steps. MIT (commercial OK).',
  },
  {
    value: 'qwen-image-local',
    label: 'Qwen-Image — Local (free)',
    provider: 'comfyui-local',
    localWorkflowId: 'qwen-image-t2i',
    hint: 'Local — best for typography. Apache 2.0 (commercial OK).',
  },
  // ─── Kie.ai cloud ──────────────────────────────────────────────────────────
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
 *  (not `IMAGE_MODELS[0].value`) because IMAGE_MODELS[0] is now a local
 *  model — defaulting prod users to a local-only flow would silently
 *  break commercial builds. Stays on Grok Imagine, the prior default. */
export const DEFAULT_IMAGE_MODEL = 'grok-imagine-t2i';

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
