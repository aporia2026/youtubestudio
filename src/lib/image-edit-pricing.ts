/**
 * Image-edit model catalog. Single source of truth consumed by:
 *
 *   - the picker in EditPanel (production-doc + shot editor): label,
 *     price, mask capability, sort key
 *   - the edit API route's dispatcher: which Kie endpoint to hit and
 *     what input shape to send
 *   - the Erase action in MaskBrushEditor: which option to force when
 *     the user asks for object removal
 *
 * Each entry is one *picker option*, not one raw model — Ideogram v3
 * has three speed tiers and GPT-4o has three quality tiers, so the
 * picker treats them as siblings instead of nested options the user
 * has to drill into.
 *
 * Pricing source: kie.ai pricing dashboard (verified per row in
 * `_plans/2026-05-23-kie-image-edit-models-and-erase.md` §5). Rows
 * with `pricePerImage: null` were not visible at plan time; the UI
 * shows "see kie.ai" for those rather than printing a guessed number
 * (CLAUDE.md rule 1).
 */

export type EditOptionId =
  // mask-capable
  | 'gpt-4o-low'
  | 'gpt-4o-medium'
  | 'gpt-4o-high'
  | 'ideogram-v3-turbo'
  | 'ideogram-v3-balanced'
  | 'ideogram-v3-quality'
  // prompt-only
  | 'nano-banana-edit'
  | 'qwen-image-edit'
  | 'qwen2-image-edit'
  | 'seedream-4.5-basic'
  | 'seedream-4.5-high'
  | 'seedream-v4'
  | 'flux-kontext-pro'
  | 'flux-kontext-max'
  // Atlas Cloud — sibling to Kie's GPT Image 2 edit family at ~30%
  // the cost. See _plans/2026-05-25-atlas-cloud-gpt-image-2.md.
  | 'gpt-image-2-atlas-edit';

/**
 * Dispatch hint for the API route. The route reads `backend.kind` and
 * builds the per-vendor input shape per the relevant docs page.
 *
 *   - `kie-standard`: POST /api/v1/jobs/createTask, model + input
 *   - `kie-gpt4o`:    POST /api/v1/gpt4o-image/generate (already wired)
 *   - `flux-kontext`: POST /api/v1/flux/kontext/generate
 *   - `atlas`:        Atlas Cloud GPT Image 2 Edit
 *                     (POST /api/v1/model/generateImage). Prompt-only;
 *                     no mask field exposed by Atlas, so options with
 *                     this backend MUST set `maskCapable: false`. See
 *                     _plans/2026-05-25-atlas-cloud-gpt-image-2.md.
 */
export type EditBackend =
  | { kind: 'kie-standard'; kieModel: string }
  | { kind: 'kie-gpt4o'; quality: 'low' | 'medium' | 'high' }
  | { kind: 'flux-kontext'; kieModel: 'flux-kontext-pro' | 'flux-kontext-max' }
  | {
      kind: 'atlas';
      /** Currently the only Atlas Edit model. Future Atlas-hosted edit
       *  variants would each get their own row here. */
      atlasModel: 'openai/gpt-image-2/edit';
      /** Atlas `size` parameter. Optional. The edit route defaults to
       *  '2560x1440' (native 16:9 at 2K) so the result matches our
       *  pipeline without a post-process crop. Atlas Edit preserves
       *  input aspect, so this hint matters only when synthesising
       *  from a smaller seed image. */
      atlasSize?: '1024x1024' | '1024x1536' | '1536x1024' | '2560x1440';
      /** Atlas `quality` tier. Optional, defaults to 'low' because every
       *  cloud image flows through Recraft Crisp Upscale downstream
       *  anyway — paying for medium/high at the source wastes money
       *  the upscaler would have spent for free. */
      atlasQuality?: 'low' | 'medium' | 'high';
    };

export interface EditOption {
  id: EditOptionId;
  /** Short name shown in the picker. */
  label: string;
  /** One-line description shown in the dropdown row + as tooltip. */
  tagline: string;
  /** When true, the option accepts a brush mask. The picker enables
   *  the Brush button only for these. */
  maskCapable: boolean;
  /** USD price per image. `null` when not verified — UI hides the
   *  number rather than print a guess. */
  pricePerImage: number | null;
  /** When true the price is per-megapixel instead of per-image. */
  pricedPerMegapixel?: boolean;
  /** Backend dispatch info. */
  backend: EditBackend;
}

/**
 * The catalog itself. Order in source = canonical sort order before
 * the price re-sort the picker applies (cheapest first, then unknown
 * prices alphabetical). Keeping a stable order here helps reviewers
 * find rows when prices shuffle.
 */
export const EDIT_OPTIONS: readonly EditOption[] = [
  // Mask-capable: brush + erase work with these.
  {
    id: 'ideogram-v3-turbo',
    label: 'Ideogram v3 Turbo',
    tagline: 'Cheapest mask inpaint — fast, decent fidelity',
    maskCapable: true,
    pricePerImage: 0.0175,
    backend: { kind: 'kie-standard', kieModel: 'ideogram/v3-edit' },
  },
  {
    id: 'ideogram-v3-balanced',
    label: 'Ideogram v3 Balanced',
    tagline: 'Mid-tier mask inpaint — balanced speed and quality',
    maskCapable: true,
    pricePerImage: 0.035,
    backend: { kind: 'kie-standard', kieModel: 'ideogram/v3-edit' },
  },
  {
    id: 'ideogram-v3-quality',
    label: 'Ideogram v3 Quality',
    tagline: 'Best Ideogram inpaint — slower, sharpest output',
    maskCapable: true,
    pricePerImage: 0.05,
    backend: { kind: 'kie-standard', kieModel: 'ideogram/v3-edit' },
  },
  {
    id: 'gpt-4o-low',
    label: 'GPT-4o Low',
    tagline: 'Cheapest GPT-4o mask edit',
    maskCapable: true,
    pricePerImage: 0.02,
    backend: { kind: 'kie-gpt4o', quality: 'low' },
  },
  {
    id: 'gpt-4o-medium',
    label: 'GPT-4o Medium',
    tagline: 'Default GPT-4o mask edit',
    maskCapable: true,
    pricePerImage: 0.07,
    backend: { kind: 'kie-gpt4o', quality: 'medium' },
  },
  {
    id: 'gpt-4o-high',
    label: 'GPT-4o High',
    tagline: 'Premium GPT-4o mask edit — slowest and priciest',
    maskCapable: true,
    pricePerImage: 0.19,
    backend: { kind: 'kie-gpt4o', quality: 'high' },
  },

  // Prompt-only: brush button stays disabled when one of these is
  // selected. The model rewrites whatever the prompt names; mask
  // inputs are not accepted by the underlying API.
  {
    id: 'nano-banana-edit',
    label: 'Nano Banana',
    tagline: 'Cheap prompt-only edit — Gemini 2.5 Flash Image',
    maskCapable: false,
    pricePerImage: 0.02,
    backend: { kind: 'kie-standard', kieModel: 'google/nano-banana-edit' },
  },
  {
    id: 'qwen-image-edit',
    label: 'Qwen Image',
    tagline: 'Prompt-only — billed per megapixel',
    maskCapable: false,
    pricePerImage: 0.03,
    pricedPerMegapixel: true,
    backend: { kind: 'kie-standard', kieModel: 'qwen/image-edit' },
  },
  {
    id: 'qwen2-image-edit',
    label: 'Qwen2 Image',
    tagline: 'Prompt-only — newer Qwen revision',
    maskCapable: false,
    // Kie.ai pricing dashboard (2026-05-23 screenshot): 5.6 credits
    // per image = $0.028 (official $0.035, 20% Kie discount). Per-
    // image billing — not per-megapixel like the older Qwen.
    pricePerImage: 0.028,
    backend: { kind: 'kie-standard', kieModel: 'qwen2/image-edit' },
  },
  {
    id: 'seedream-4.5-basic',
    label: 'Seedream 4.5 Basic',
    tagline: 'Prompt-only — 2K output, ByteDance',
    maskCapable: false,
    // Kie.ai pricing dashboard (2026-05-23 screenshot): 6.5 credits
    // per image = $0.0325. High-tier top-ups bring effective price
    // down to ~$0.030; we show the base figure so the displayed cost
    // matches what an average-tier user actually pays.
    pricePerImage: 0.0325,
    backend: { kind: 'kie-standard', kieModel: 'seedream/4.5-edit' },
  },
  {
    id: 'seedream-4.5-high',
    label: 'Seedream 4.5 High',
    tagline: 'Prompt-only — 4K output, ByteDance',
    maskCapable: false,
    pricePerImage: 0.0325,
    backend: { kind: 'kie-standard', kieModel: 'seedream/4.5-edit' },
  },
  {
    id: 'seedream-v4',
    label: 'Seedream v4',
    tagline: 'Prompt-only — Seedream 4.0 edit revision',
    maskCapable: false,
    // Kie.ai pricing dashboard (2026-05-23 screenshot): 5 credits
    // per image = $0.025, resolution-independent. High-tier top-ups
    // bring effective price to ~$0.0225 (~10% off). We show the base
    // figure for the average-tier user.
    pricePerImage: 0.025,
    backend: { kind: 'kie-standard', kieModel: 'bytedance/seedream-v4-edit' },
  },
  // Flux Kontext: not listed on the kie.ai /pricing dashboard as of
  // 2026-05-23 (the user checked). Billing is handled through Flux's
  // own credit system on kie.ai. Leaving `pricePerImage: null` so the
  // dropdown surfaces "see kie.ai" instead of inventing a number
  // (CLAUDE.md rule 1). Live-tested via scripts/test-flux-kontext.ts
  // — wiring works; we just don't know what each call costs.
  {
    id: 'flux-kontext-pro',
    label: 'Flux Kontext Pro',
    tagline: 'Prompt-only — Black Forest Labs',
    maskCapable: false,
    pricePerImage: null,
    backend: { kind: 'flux-kontext', kieModel: 'flux-kontext-pro' },
  },
  {
    id: 'flux-kontext-max',
    label: 'Flux Kontext Max',
    tagline: 'Prompt-only — Flux Kontext premium tier',
    maskCapable: false,
    pricePerImage: null,
    backend: { kind: 'flux-kontext', kieModel: 'flux-kontext-max' },
  },
  // Atlas Cloud GPT Image 2 Edit — added 2026-05-25 alongside the Atlas
  // t2i entry in image-models.ts. Same OpenAI model the Kie GPT-4o path
  // covers, routed through Atlas's cheaper invoice. Atlas Edit is
  // token-billed (~$0.01/call estimate; the dispatcher logs the actual
  // token counts so we can true up after a week of traffic). No mask
  // support, so this option deliberately sits in the prompt-only group
  // below — the eraser flow on /api/overlay/edit filters by
  // `maskCapable: true` and won't surface this entry.
  {
    id: 'gpt-image-2-atlas-edit',
    label: 'GPT Image 2 Edit (Atlas)',
    tagline: 'Cheap prompt-only edit — Atlas Cloud, ~$0.011 at 2K + low',
    maskCapable: false,
    pricePerImage: 0.011,
    backend: {
      kind: 'atlas',
      atlasModel: 'openai/gpt-image-2/edit',
      // Match the t2i + i2i defaults: native 16:9 at 2K + low quality.
      // Atlas Edit preserves input aspect, so when the input is already
      // 16:9 (the common case for editing pipeline outputs) the size
      // hint mainly governs upscale eligibility. Atlas Edit also runs
      // through upscaleViaRecraft in the route's switch — the >2000px
      // guard handles the no-op skip when inputs are already 2K.
      atlasSize: '2560x1440',
      atlasQuality: 'low',
    },
  },
];

const OPTIONS_BY_ID: ReadonlyMap<EditOptionId, EditOption> = new Map(
  EDIT_OPTIONS.map(opt => [opt.id, opt]),
);

export function getEditOption(id: string): EditOption | undefined {
  return OPTIONS_BY_ID.get(id as EditOptionId);
}

/** Default option a fresh user sees. Cheapest prompt-only model. */
export const DEFAULT_EDIT_OPTION_ID: EditOptionId = 'nano-banana-edit';

/**
 * Default backend used by the **Erase** button in MaskBrushEditor when
 * the user paints over an object and asks for it to be removed. The
 * server forces this option (ignoring the picker's current choice) so
 * a single click does the right thing without making the user pick a
 * mask-capable model first.
 *
 * Ideogram v3 Quality is purpose-built for inpainting and cheaper than
 * GPT-4o Medium ($0.05 vs $0.07). Exposed as a user setting in
 * `src/lib/editor/settings.ts` (`getDefaultEraseBackendId`).
 */
export const DEFAULT_ERASE_OPTION_ID: EditOptionId = 'ideogram-v3-quality';

/**
 * Erase prompt sent to the mask-capable backend. Server-generated, not
 * client-controlled — keeps the Erase action genuinely one-click and
 * blocks a tampered client from sneaking a wider regen by spoofing the
 * intent.
 */
export const ERASE_PROMPT =
  'Remove the painted region and rebuild the background seamlessly to match the surrounding image. ' +
  'Preserve the rest of the image exactly.';

/**
 * Picker-ready list, sorted: known prices ascending, then unknown
 * prices alphabetical. Mask-capable rows are not separated — the
 * picker decorates them with an icon and the user picks freely; the
 * Brush button reads `maskCapable` to enable or disable itself.
 */
export function getSortedEditOptions(): readonly EditOption[] {
  const known = EDIT_OPTIONS.filter(o => o.pricePerImage !== null);
  const unknown = EDIT_OPTIONS.filter(o => o.pricePerImage === null);
  known.sort((a, b) => (a.pricePerImage as number) - (b.pricePerImage as number));
  unknown.sort((a, b) => a.label.localeCompare(b.label));
  return [...known, ...unknown];
}

/**
 * Compose the row label the dropdown renders. `Nano Banana — $0.02`
 * or `Qwen Image — $0.03/MP` or `Seedream v4 — see kie.ai` for
 * unverified prices.
 *
 * Price formatting: render at 4 decimals max, strip trailing zeros,
 * always keep at least 2 decimals. So $0.02 stays "0.02" and $0.0175
 * stays "0.0175" — both lossless, neither padded.
 */
export function formatEditOptionLabel(opt: EditOption): string {
  if (opt.pricePerImage === null) return `${opt.label} — see kie.ai`;
  const unit = opt.pricedPerMegapixel ? '/MP' : '';
  const padded = opt.pricePerImage.toFixed(4);
  const price = padded.replace(/(\.\d{2,}?)0+$/, '$1');
  return `${opt.label} — $${price}${unit}`;
}
