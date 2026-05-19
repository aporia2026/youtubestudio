// Client-safe image-model registry for Kie.ai text-to-image models.
//
// Used by surfaces that turn a text prompt into an image (e.g. the production
// doc per-row image generator). The thumbnails page has its own registry that
// also covers image-to-image variants — keep this one focused on t2i.

export interface ImageModelSpec {
  /** Stable id used in URLs / API bodies / localStorage. */
  value: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Underlying Kie.ai `model` string sent to /api/v1/jobs/createTask. */
  kieModel: string;
  /** One-line hint shown in the picker. */
  hint?: string;
}

export const IMAGE_MODELS: ImageModelSpec[] = [
  { value: 'grok-imagine-t2i', label: 'Grok Imagine', kieModel: 'grok-imagine/text-to-image', hint: 'Default — fast, broad style range' },
  { value: 'flux2-pro-t2i', label: 'Flux 2 Pro', kieModel: 'flux-2/pro-text-to-image', hint: 'Highest fidelity — slower, costlier' },
  { value: 'flux2-flex-t2i', label: 'Flux 2 Flex', kieModel: 'flux-2/flex-text-to-image', hint: 'Flux 2 — balanced cost/quality' },
  { value: 'nano-banana', label: 'Google NanoBanana', kieModel: 'google/nano-banana', hint: 'Google Imagen via Kie.ai' },
  { value: 'gpt-image-2-t2i', label: 'GPT Image 2', kieModel: 'gpt-image-2-text-to-image', hint: 'OpenAI image model via Kie.ai' },
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
  { value: 'ideogram-v3-quality-t2i', label: 'Ideogram v3 Quality', kieModel: 'ideogram/v3-text-to-image', hint: 'Best-in-class text rendering — $0.05/image' },
  { value: 'ideogram-v3-turbo-t2i', label: 'Ideogram v3 Turbo', kieModel: 'ideogram/v3-text-to-image', hint: 'Cheap, fast text rendering — $0.0175/image' },
];

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].value;

export function getImageModelSpec(value: string): ImageModelSpec | undefined {
  return IMAGE_MODELS.find(m => m.value === value);
}

/** Build the per-model `input` payload for Kie.ai's createTask call.
 *  Centralised so client + server agree on which fields each model family needs.
 *  Always 16:9 — the production doc renders at video aspect. */
export function buildKieImageInput(modelValue: string, prompt: string): Record<string, unknown> {
  const spec = getImageModelSpec(modelValue);
  const kieModel = spec?.kieModel ?? IMAGE_MODELS[0].kieModel;
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
