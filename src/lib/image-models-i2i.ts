/**
 * Image-to-image model registry for v2 user-defined styles.
 *
 * Kept separate from `image-models.ts` (which is t2i-focused per the
 * comment at the top of that file). i2i models carry extra metadata
 * that doesn't apply to t2i — the reference-images field name varies
 * per Kie model family, the max ref count varies per model, and local
 * variants need a ComfyUI workflow id instead of a Kie model string.
 *
 * Verified against docs.kie.ai during the Phase 0 cloud spike
 * (2026-05-21) — see `_plans/2026-05-21-phase-0-spike-prompts.md`
 * for the per-model behaviour matrix. NanoBanana Pro originally won
 * the spike on a speed tiebreaker but has since been retired in
 * favour of NanoBanana 2 (Gemini 3.1 Flash Image) which covers v1's
 * capability at lower cost ($0.04 vs $0.05/image) and is faster.
 * Local Qwen-Image won the local spike (single-ref via VAE-encode)
 * so it's the local default when LOCAL_STUDIO=1 + ComfyUI reachable.
 *
 * Consumers:
 *   - editor picker             → `I2I_MODELS` for the dropdown options
 *   - styles validator          → `I2I_MODEL_VALUES` allow-list for
 *                                  `preferred_cloud_model` storage
 *   - cloud dispatcher          → `buildKieI2IInput` + `getI2IModelSpec`
 *   - local dispatcher          → `getI2IModelSpec().localWorkflowId`
 *   - production-doc image route → branches on provider via `getI2IModelSpec`
 *
 * ─── 1K-only policy ───────────────────────────────────────────────────────
 * Every cloud (kie) i2i call here is pinned to 1K output. Every cloud
 * generation also flows through the system-wide auto-upscale pass
 * (`src/lib/upscale.ts`, Recraft Crisp Upscale, ~4×, $0.0025/image), so
 * the final shot lands at ~4K regardless. Bumping any model to 2K/4K at
 * the source pays the model's higher-tier price for output that the
 * upscaler would have produced for $0.0025 anyway. `buildKieI2IInput`
 * enforces this at the bottom of the function. See
 * `tests/image-models-1k-enforcement.test.ts`.
 *
 * ─── Read-time fallback for retired models ────────────────────────────────
 * `getI2IModelSpec` returns the default spec for unknown values instead
 * of `undefined`. Lets retired entries (e.g. `'nano-banana-pro-i2i'`
 * before the 2026-05-24 swap) resolve cleanly without a DB migration —
 * the call logs a warning and falls back to `DEFAULT_CLOUD_I2I_MODEL`.
 */

export type I2IProvider = 'kie' | 'comfyui-local';

/** Workflow ids for local i2i models. Matches the LocalImageWorkflowId
 *  union in `src/lib/comfyui/style-mapping.ts` — the comfyui-local
 *  generator auto-swaps t2i → i2i variants when `refImageFilename` is
 *  supplied, so pinning the t2i id is the right pattern here. */
export type I2ILocalWorkflowId =
  | 'qwen-image-t2i'
  | 'flux-schnell-t2i'
  | 'hidream-i1-dev-t2i'
  // Qwen-Image-Edit-2509 multi-ref (up to 3) — only-i2i, no t2i
  // counterpart, so we pin the i2i workflow id directly. The
  // ComfyUILocalGenerator's i2iVariantOf passes this through
  // unchanged since it has no t2i variant in the mapping.
  | 'qwen-image-edit-2509-i2i';

export interface I2IModelSpec {
  /** Stable id used in DB rows (`preferred_cloud_model`), API bodies,
   *  localStorage. Once shipped, treat as immutable — renaming an
   *  entry orphans every style row that picked it. */
  value: string;
  /** Human-readable label for the editor's model dropdown. Plain
   *  English per the council's Outsider feedback — the dropdown
   *  should have an opinion, not list raw provider names. */
  label: string;
  /** Where the generation runs. */
  provider: I2IProvider;
  /** Underlying Kie.ai `model` string sent to /api/v1/jobs/createTask.
   *  Required for `provider: 'kie'`. */
  kieModel?: string;
  /** ComfyUI workflow id — `provider: 'comfyui-local'` only. The
   *  ComfyUILocalGenerator auto-swaps to the i2i variant of this
   *  workflow when a refImageFilename is supplied. */
  localWorkflowId?: I2ILocalWorkflowId;
  /** Name of the input field carrying reference image URLs. Cloud
   *  models only. Single-URL field shape (Ideogram Remix family)
   *  vs array field shape (Flux 2 / GPT Image 2 / NanoBanana). */
  refsField?: 'image_input' | 'input_urls' | 'image_url';
  /** Max reference images this i2i variant accepts. The dispatcher
   *  trims refs beyond this cap before sending. Local Qwen uses 1
   *  (single anchor via VAE-encode); cloud variants accept 8 or 16. */
  maxRefs: number;
  /** Extra input fields appended to the Kie createTask `input` object
   *  beyond `prompt` + the refs field. Verified per-model against
   *  docs.kie.ai during the Phase 0 spike — note that some
   *  documented-as-accepted fields actually 500 in practice (e.g.
   *  NanoBanana Pro: `output_format` + `resolution` were verified to
   *  trip the endpoint even though the docs list them). */
  extraInput?: Record<string, unknown>;
  /** Plain-English hint shown under the picker option. Includes
   *  cost + typical latency + any provider-specific caveat. */
  hint?: string;
  /** Approximate USD per image — `0` for local / free, undefined for
   *  unknown. Cloud values are rough estimates from the Phase 0 spike
   *  spend (2026-05-21); actual Kie pricing varies by date and quota
   *  and the source of truth is https://kie.ai pricing. Used by UIs
   *  that surface a cost preview before paid actions (rule 8). */
  costUsdPerImage?: number;
}

export const I2I_MODELS: readonly I2IModelSpec[] = Object.freeze([
  // Cloud — NanoBanana 2 (Gemini 3.1 Flash Image) replaced the original
  // NanoBanana Pro on 2026-05-24. Spec verified against
  // docs.kie.ai/market/google/nanobanana2 — same `image_input` refs
  // field shape as Pro, but `maxRefs` bumps from 8 → 14, the model
  // accepts both `aspect_ratio` and `resolution` (we pin both), and
  // pricing drops from $0.05 → $0.04 per 1K image.
  {
    value: 'nano-banana-2-i2i',
    label: 'Reference-driven (NanoBanana 2)',
    provider: 'kie',
    kieModel: 'nano-banana-2',
    refsField: 'image_input',
    maxRefs: 14,
    extraInput: { aspect_ratio: '16:9', resolution: '1K', output_format: 'png' },
    hint: 'Default for ref-bearing styles. Gemini 3.1 Flash, ~$0.04/image, supports 14 references.',
    costUsdPerImage: 0.04,
  },
  {
    value: 'gpt-image-2-i2i',
    label: 'Reference-driven (GPT Image 2)',
    provider: 'kie',
    kieModel: 'gpt-image-2-image-to-image',
    refsField: 'input_urls',
    maxRefs: 16,
    extraInput: { aspect_ratio: '16:9', resolution: '1K' },
    hint: 'Highest ref capacity (16). ~$0.05/image, slower at ~170s.',
    costUsdPerImage: 0.05,
  },
  {
    value: 'flux2-pro-i2i',
    label: 'Reference-driven (Flux 2 Pro)',
    provider: 'kie',
    kieModel: 'flux-2/pro-image-to-image',
    refsField: 'input_urls',
    maxRefs: 8,
    extraInput: { aspect_ratio: '16:9', resolution: '1K' },
    hint: 'Fast (~$0.05/image, ~35s) but biased toward polished aesthetics; may refuse some prompts.',
    costUsdPerImage: 0.05,
  },
  // Local — Qwen-Image i2i won the 2026-05-22 local spike on the doodle
  // aesthetic. Single-ref by workflow contract (one VAE-encoded anchor
  // as the starting latent). Workflow at
  // src/lib/comfyui/workflows/qwen-image-i2i.json; the
  // ComfyUILocalGenerator auto-swaps from t2i to i2i when a
  // refImageFilename is supplied.
  {
    value: 'local-qwen-i2i',
    label: 'Reference-driven — Local (Qwen-Image, single-ref)',
    provider: 'comfyui-local',
    localWorkflowId: 'qwen-image-t2i',
    maxRefs: 1,
    hint: 'Free local generation. Uses your top reference image only. Requires LOCAL_STUDIO=1 + ComfyUI + Qwen-Image base model.',
    costUsdPerImage: 0,
  },
  // Local — Qwen-Image-Edit-2509 multi-ref (up to 3). Different
  // diffusion checkpoint from Qwen-Image (same family, trained for
  // editing/multi-ref tasks). Conditioning shape is different too:
  // TextEncodeQwenImageEditPlus encodes 3 ref images into the prompt
  // CLIP via cross-attention rather than VAE-encoding the anchor as
  // the starting latent. Quality is comparable to Qwen-Image i2i;
  // possibly better for ref-driven style transfer specifically since
  // that's the task it was trained for. Workflow pinned directly to
  // qwen-image-edit-2509-i2i (no t2i counterpart).
  {
    value: 'local-qwen-edit-2509-i2i',
    label: 'Reference-driven — Local (Qwen-Image-Edit 2509, up to 3 refs)',
    provider: 'comfyui-local',
    localWorkflowId: 'qwen-image-edit-2509-i2i',
    maxRefs: 3,
    hint: 'Free local. Uses up to 3 reference images via cross-attention. Requires qwen_image_edit_2509_fp8_e4m3fn.safetensors in models/diffusion_models/ + qwen_2.5_vl_7b_fp8_scaled in text_encoders/ + qwen_image_vae in vae/.',
    costUsdPerImage: 0,
  },
]);

/** Quick helper for UIs that need to surface "free" vs "$X" before a
 *  paid action (rule 8). Returns null when the model has no cost
 *  field (defensive — caller should fall back to a generic label). */
export function formatI2ICostHint(modelValue: string): string | null {
  const spec = getI2IModelSpec(modelValue);
  if (!spec || typeof spec.costUsdPerImage !== 'number') return null;
  if (spec.costUsdPerImage === 0) return 'free';
  return `~$${spec.costUsdPerImage.toFixed(2)}/image`;
}

/** Default cloud model for ref-bearing v2 styles. Original Phase 0 spike
 *  winner was NanoBanana Pro; replaced on 2026-05-24 by NanoBanana 2
 *  (Gemini 3.1 Flash Image) which covers the same capability at lower
 *  cost. See `_plans/2026-05-24-system-upscale-and-collage.md`. */
export const DEFAULT_CLOUD_I2I_MODEL = 'nano-banana-2-i2i';

/** All known i2i model values. Used by the styles validator to
 *  allow-list `preferred_cloud_model` storage. Single source of truth
 *  — adding an entry to `I2I_MODELS` surfaces it here automatically.
 *
 *  Note: the validator should treat this as the *current* allow-list,
 *  not the *historical* one. Retired values (e.g. `'nano-banana-pro-i2i'`
 *  before the 2026-05-24 swap) resolve to the default via the read-time
 *  fallback in `getI2IModelSpec` — `I2I_MODEL_VALUES` deliberately
 *  doesn't include them. */
export const I2I_MODEL_VALUES: readonly string[] = I2I_MODELS.map((m) => m.value);

/** Look up an i2i spec by its stored `value`. Falls back to the default
 *  spec when the requested value is unknown (e.g. an old DB row storing
 *  a retired model id like `'nano-banana-pro-i2i'`). Logs a warning so
 *  registry drift is visible in production logs — silent fallback would
 *  also mask an attacker storing garbage to coerce model selection.
 *
 *  Returns `undefined` only if the default itself can't be resolved
 *  (registry corruption — should never happen). */
export function getI2IModelSpec(value: string): I2IModelSpec | undefined {
  const direct = I2I_MODELS.find((m) => m.value === value);
  if (direct) return direct;
  const fallback = I2I_MODELS.find((m) => m.value === DEFAULT_CLOUD_I2I_MODEL);
  if (fallback) {
    console.warn('[i2i registry] unknown model → falling back to default', {
      requested: value,
      fallback: DEFAULT_CLOUD_I2I_MODEL,
    });
    return fallback;
  }
  return undefined;
}

/** Type guard for cloud-Kie i2i specs. Narrows the optional fields
 *  `kieModel` and `refsField` to non-undefined so the dispatcher can
 *  call into the Kie path without `!` non-null assertions. Catches
 *  registry misconfiguration at the type level — adding a new Kie
 *  entry without `kieModel` or `refsField` fails the narrow at the
 *  call site instead of crashing at runtime. */
export function isKieI2ISpec(spec: I2IModelSpec): spec is I2IModelSpec & {
  provider: 'kie';
  kieModel: string;
  refsField: 'image_input' | 'input_urls' | 'image_url';
} {
  return (
    spec.provider === 'kie'
    && typeof spec.kieModel === 'string'
    && spec.kieModel.length > 0
    && (spec.refsField === 'image_input' || spec.refsField === 'input_urls' || spec.refsField === 'image_url')
  );
}

/**
 * Build the per-model `input` payload for a Kie.ai i2i createTask call.
 * Assembles the refs array into whichever field name the chosen i2i
 * model expects, merges in the spec's `extraInput`, trims refs to the
 * model's `maxRefs`. Ref URLs beyond the cap are dropped so the
 * request stays valid.
 *
 * Throws when called for a non-Kie or non-i2i model — the dispatcher
 * is expected to branch on `spec.provider` BEFORE reaching this
 * function (cloud → buildKieI2IInput; local → ComfyUI workflow fill).
 */
export function buildKieI2IInput(
  modelValue: string,
  prompt: string,
  refUrls: readonly string[],
): Record<string, unknown> {
  const spec = getI2IModelSpec(modelValue);
  if (!spec || spec.provider !== 'kie' || !spec.refsField) {
    throw new Error(`buildKieI2IInput called for non-Kie-i2i model '${modelValue}'`);
  }
  if (refUrls.length === 0) {
    throw new Error(`buildKieI2IInput called with no reference URLs for '${modelValue}'`);
  }
  const trimmed = refUrls.slice(0, spec.maxRefs);
  const input: Record<string, unknown> = {
    prompt,
    ...(spec.extraInput ?? {}),
  };
  if (spec.refsField === 'image_url') {
    // Single-URL field (Ideogram Remix family). Position 0 is the
    // strongest anchor by ref-ordering convention.
    input.image_url = trimmed[0];
  } else {
    input[spec.refsField] = trimmed;
  }

  // 1K-policy enforcement (see top-of-file comment). If any spec's
  // `extraInput.resolution` ever drifts to 2K/4K, this guard fires
  // before the request leaves the process. The guard only checks when
  // `resolution` is set — models that omit the field are unaffected.
  if (input.resolution !== undefined && input.resolution !== '1K') {
    throw new Error(
      `[i2i registry 1k-policy] blocked non-1K resolution for ${modelValue}: ${String(input.resolution)} — every cloud generation gets auto-upscaled, bumping the source tier wastes money`,
    );
  }
  return input;
}
