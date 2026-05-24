// Client-safe image-model registry for production-doc per-row image generation.
//
// Used by surfaces that turn a text prompt into an image. Two providers:
//   - `kie`           → Kie.ai cloud, per-image cost (existing default)
//   - `comfyui-local` → ComfyUI on the user's PC, $0 per image, requires
//                       LOCAL_STUDIO=1 in dev (Phase 4 of the local-broll
//                       plan). Routes return 503 if the env flag is missing.
//
// This file is t2i-only — the v2 image-to-image registry (NanoBanana 2 i2i,
// Flux 2 Pro i2i, GPT Image 2 i2i) lives in `image-models-i2i.ts`. Keep
// this one focused on per-row generation per its consumer at the picker.
//
// ─── 1K-only policy ────────────────────────────────────────────────────────
// Every cloud (kie) generation in this registry is pinned to 1K output.
// Every cloud generation also flows through the system-wide auto-upscale
// pass (`src/lib/upscale.ts`, Recraft Crisp Upscale, ~4×, $0.0025/image).
// Net result: each shot lands at ~4K with one generation call worth of
// inference cost + a quarter cent of upscale. Bumping any model to 2K/4K
// at the source pays the model's higher-tier price ($0.06–$0.09 on
// NanoBanana 2) for output that the upscaler would have produced for
// $0.0025 anyway. Don't do it.
//
// `buildKieImageInput` enforces this at the bottom of the function — if a
// caller mutates the registry or a future entry slips in a non-1K
// `resolution`, the builder throws at request time instead of silently
// burning money. See `tests/image-models-1k-enforcement.test.ts`.

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
    label: 'HiDream-I1 — Local (i2i only on 16 GB)',
    provider: 'comfyui-local',
    localWorkflowId: 'hidream-i1-dev-t2i',
    // Workflow is correct as of 2026-05-22 (Q4_K_M UNet + Q5_K_M GGUF
    // t5xxl — the earlier fp8 t5 erred out with "Mixing scaled FP8
    // with GGUF is not supported"). Verified on RTX 5070 Ti 16 GB:
    //   - t2i:  hangs at KSampler (901s timeout, zero node progress).
    //   - i2i:  WORKS, ~75s warm per image at 1024×576, 28 steps.
    // The i2i path likely passes because the VAE-encoded reference
    // latent occupies the slot that t2i would use for a full noise
    // tensor + activation cache during text encoding — the working
    // set just barely fits when the reference is precomputed. Kept
    // in the picker because the i2i path is real; labelled so users
    // know t2i won't work for them on this hardware.
    hint: 'Premium 28 steps, MIT. i2i works (~75s warm); t2i hangs on 16 GB.',
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
  // NanoBanana 2 (Gemini 3.1 Flash Image). The `value` stays `'nano-banana'`
  // so existing rows that picked the older Gemini 2.5 Flash entry resolve
  // to the new model without a DB migration. The underlying kie model
  // string changes to `nano-banana-2`. Same `image_input` refs field is
  // exposed by the i2i registry entry (max 14 refs).
  { value: 'nano-banana', label: 'Google NanoBanana 2', provider: 'kie', kieModel: 'nano-banana-2', hint: 'Gemini 3.1 Flash Image — fast, accurate text rendering, $0.04/image' },
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
 *  Always 16:9 at 1K — the production doc renders at video aspect, and every
 *  generation gets system-upscaled (see top-of-file 1K-only policy block).
 *
 *  Throws if called for a non-kie model — caller is expected to dispatch
 *  on `spec.provider` BEFORE reaching this function. Throws if any branch
 *  ends up setting `resolution` to anything other than `'1K'` (defence in
 *  depth against future edits drifting from the upscale-everything policy). */
export function buildKieImageInput(modelValue: string, prompt: string): Record<string, unknown> {
  const spec = getImageModelSpec(modelValue);
  if (!spec || spec.provider === 'comfyui-local' || !spec.kieModel) {
    throw new Error(`buildKieImageInput called for non-Kie model '${modelValue}'`);
  }
  const kieModel = spec.kieModel;
  const input: Record<string, unknown> = { prompt };

  // GPT Image 2 and Ideogram v3 don't document an nsfw_checker field;
  // sending it can 422 on stricter validators. NanoBanana 2 also doesn't
  // expose nsfw_checker (Gemini handles content policy server-side).
  if (
    !kieModel.startsWith('gpt-image-2')
    && !kieModel.startsWith('ideogram/')
    && kieModel !== 'nano-banana-2'
  ) {
    input.nsfw_checker = true;
  }

  if (kieModel.startsWith('flux-2')) {
    input.aspect_ratio = '16:9';
    input.resolution = '1K';
  } else if (kieModel === 'nano-banana-2') {
    // Gemini 3.1 Flash Image. Same field shape as GPT Image 2:
    // `aspect_ratio` + `resolution`. Defaults to 'auto' / '1K' per
    // docs.kie.ai/market/google/nanobanana2 — we pin both.
    input.aspect_ratio = '16:9';
    input.resolution = '1K';
    input.output_format = 'png';
  } else if (kieModel.startsWith('gpt-image-2')) {
    input.aspect_ratio = '16:9';
    input.resolution = '1K';
  } else if (kieModel === 'ideogram/v3-text-to-image') {
    // Ideogram uses enum names for aspect (not "16:9") and routes the
    // tier through the rendering_speed field — all three tiers share
    // the single `ideogram/v3-text-to-image` model string, so the
    // speed is encoded in the spec value. Ideogram has no `resolution`
    // field; the 1K guard below doesn't fire because we don't set one.
    input.image_size = 'landscape_16_9';
    input.rendering_speed = modelValue.includes('turbo')
      ? 'TURBO'
      : modelValue.includes('balanced')
        ? 'BALANCED'
        : 'QUALITY';
  } else {
    input.aspect_ratio = '16:9';
  }

  // 1K-policy enforcement (see top-of-file comment). If any branch above
  // ever drifts to 2K/4K, this guard fires before the request leaves the
  // process. The guard only checks when `resolution` is set — models that
  // omit the field (Ideogram, future entries) are unaffected.
  if (input.resolution !== undefined && input.resolution !== '1K') {
    throw new Error(
      `[image registry 1k-policy] blocked non-1K resolution for ${modelValue}: ${String(input.resolution)} — every cloud generation gets auto-upscaled, bumping the source tier wastes money`,
    );
  }
  return input;
}
