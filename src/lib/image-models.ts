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

  // GPT Image 2 doesn't document an nsfw_checker field; sending it can 422.
  if (!kieModel.startsWith('gpt-image-2')) {
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
  } else {
    input.aspect_ratio = '16:9';
  }
  return input;
}
