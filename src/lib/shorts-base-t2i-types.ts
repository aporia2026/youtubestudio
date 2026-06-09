/**
 * Client-safe slice of `shorts-base-t2i.ts` — types, the model
 * registry, and the pure resolver/lookup helpers. Lives in its own
 * module so client components (the batch RetryAssetsPicker, the
 * editor's base-model picker) can import it without dragging the
 * server-only image generators (sharp, atlas, kie) into the browser
 * bundle.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *       _plans/2026-06-09-bulk-shorts-robustness-and-inspector.md (§8 picker expansion).
 *
 * Mirrors the existing `shorts-types.ts` ↔ `shorts.ts` and
 * `shorts-batch-stages.ts` ↔ `shorts-batch-orchestrator.ts` splits.
 *
 * Cropping policy: every model's output flows through
 * `cropToAspectAndUpload(_, _, 9, 16)` in the dispatcher regardless of
 * what aspect the model natively produced. That's the safety net that
 * lets us add a model without per-model portrait-enum verification —
 * worst case the source is square or landscape and the crop discards
 * the side panels; we still end up with exact 9:16. Marker
 * `nativePortrait: true` is documentation only — the crop runs either
 * way (no-op when source is already 9:16). See dispatcher in
 * `shorts-base-t2i.ts`.
 */

/** Every base T2I model the picker can target. Keep this union in
 *  lockstep with `BASE_T2I_MODELS` below so `resolveBaseT2iModelId`
 *  can narrow at runtime without an unsafe cast. */
export type ShortsBaseT2iModelId =
  | 'atlas-gpt-image-2'
  | 'kie-gpt-image-2'
  | 'kie-nano-banana-2'
  | 'kie-flux-2-pro'
  | 'kie-flux-2-flex'
  | 'kie-ideogram-v3-quality'
  | 'kie-ideogram-v3-turbo'
  | 'kie-qwen-image'
  | 'kie-seedream-v4';

export interface ShortsBaseT2iModelSpec {
  id: ShortsBaseT2iModelId;
  /** Short display label for the dropdown. */
  label: string;
  /** Vendor identifier ('atlas' | 'kie'). */
  vendor: 'atlas' | 'kie';
  /** Flat per-call cost USD. Tracked locally because Kie's invoice
   *  arrives async; this is the audit-row estimate the caller logs.
   *  See `_plans/2026-06-09-bulk-shorts-robustness-and-inspector.md`
   *  §8 — costs marked ~ are best-effort from Kie pricing pages and
   *  may need correction once invoices land. */
  costUsd: number;
  /** Underlying model id Kie / Atlas expects on the wire. */
  modelSlug: string;
  /** Short one-liner shown under the option to help the user pick. */
  hint: string;
}

/** Registry order matters for picker UX: cheapest cost-tier first,
 *  with sibling models grouped (Atlas next to Kie GPT-2, Ideogram
 *  Quality next to Turbo).
 *
 *  Deep-frozen at module load (per QA L1) — the prior shallow
 *  `Object.freeze` only locked the array slot, leaving each model
 *  spec's fields mutable. Deep freeze makes the safety net real. */
const _BASE_T2I_MODELS_RAW: ShortsBaseT2iModelSpec[] = ([
  // ─── OpenAI GPT Image 2 (two vendor routes — same underlying model) ────
  {
    id: 'atlas-gpt-image-2',
    label: 'Atlas GPT Image 2',
    vendor: 'atlas',
    costUsd: 0.009,
    modelSlug: 'openai/gpt-image-2/text-to-image',
    hint: 'Cost-optimal route. Same OpenAI model as Kie GPT-2 but cheaper.',
  },
  {
    id: 'kie-gpt-image-2',
    label: 'Kie GPT Image 2',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'gpt-image-2-text-to-image',
    hint: 'Sibling of Atlas above (same OpenAI model, Kie gateway). 5× cost; current default for vendor reliability.',
  },
  // ─── Google Gemini 3.1 Flash Image ─────────────────────────────────────
  {
    id: 'kie-nano-banana-2',
    // Per QA N1: surface the underlying provider in the label so the
    // picker doesn't make the user read the hint to know what this is.
    label: 'Nano Banana 2 (Google Gemini 3.1 Flash Image)',
    vendor: 'kie',
    costUsd: 0.04,
    modelSlug: 'nano-banana-2',
    hint: 'Fast, distinct visual style. Native 9:16.',
  },
  // ─── Black Forest Labs Flux 2 family ───────────────────────────────────
  {
    id: 'kie-flux-2-pro',
    label: 'Flux 2 Pro',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'flux-2/pro-text-to-image',
    hint: 'Flux 2 Pro — typically richer composition + lighting.',
  },
  {
    id: 'kie-flux-2-flex',
    label: 'Flux 2 Flex',
    vendor: 'kie',
    costUsd: 0.025,
    modelSlug: 'flux-2/flex-text-to-image',
    hint: 'Cheaper sibling of Flux 2 Pro — same family, balanced cost/quality.',
  },
  // ─── Grok Imagine deliberately NOT in the registry (2026-06-10 QA) ────
  // docs.kie.ai shows `grok-imagine/image-to-image` and
  // `grok-imagine/text-to-video` but NO text-to-image endpoint. The
  // production-doc registry's `grok-imagine/text-to-image` slug appears
  // to be undocumented or deprecated — sending it 422s with
  // "model not found", which the retry classifier won't retry and the
  // user sees as a vague error string with no path forward. Removed
  // until Kie publishes a Grok T2I endpoint we can verify.
  // ─── Ideogram v3 (two render-speed tiers, same model slug) ─────────────
  {
    id: 'kie-ideogram-v3-quality',
    label: 'Ideogram v3 Quality',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'ideogram/v3-text-to-image',
    hint: 'Ideogram v3 Quality — best-in-class legible in-image text rendering.',
  },
  {
    id: 'kie-ideogram-v3-turbo',
    label: 'Ideogram v3 Turbo',
    vendor: 'kie',
    costUsd: 0.0175,
    modelSlug: 'ideogram/v3-text-to-image',
    hint: 'Cheaper Ideogram v3 tier — fast, still strong text rendering.',
  },
  // ─── Alibaba Qwen Image ────────────────────────────────────────────────
  {
    id: 'kie-qwen-image',
    label: 'Qwen Image',
    vendor: 'kie',
    costUsd: 0.03,
    modelSlug: 'qwen/text-to-image',
    hint: 'Alibaba Qwen — strong typography + multilingual prompts.',
  },
  // ─── ByteDance Seedream v4 ─────────────────────────────────────────────
  {
    id: 'kie-seedream-v4',
    label: 'Seedream v4',
    vendor: 'kie',
    costUsd: 0.03,
    modelSlug: 'bytedance/seedream-v4-text-to-image',
    hint: 'ByteDance Seedream v4 — distinct illustration / poster aesthetic.',
  },
]);

/** Deep-frozen view of the registry — both the array and every entry's
 *  fields are immutable. The cast to `readonly` reflects the runtime
 *  guarantee at the type level. */
export const BASE_T2I_MODELS: readonly Readonly<ShortsBaseT2iModelSpec>[] = Object.freeze(
  _BASE_T2I_MODELS_RAW.map((m) => Object.freeze({ ...m })),
);

/** Default base T2I model for the shorts asset pipeline. User-confirmed
 *  on 2026-06-09 to switch away from `atlas-gpt-image-2` (5.6× cheaper
 *  but Atlas has been unreliable — see motion-collage grid revert and
 *  image-model forwarding fixes in recent commits) to `kie-gpt-image-2`
 *  (same underlying OpenAI gpt-image-2 model, different vendor gateway).
 *  See `_plans/2026-06-09-bulk-shorts-robustness-and-inspector.md` §7. */
export const DEFAULT_BASE_T2I_MODEL_ID: ShortsBaseT2iModelId = 'kie-gpt-image-2';

/** Defensive resolver — narrows an arbitrary string to a valid model
 *  id, falling back to the cost-optimal default on bad input. Pure;
 *  used by the API + UI layers so a stale stored value never crashes
 *  the dispatcher. */
export function resolveBaseT2iModelId(raw: unknown): ShortsBaseT2iModelId {
  if (typeof raw !== 'string') return DEFAULT_BASE_T2I_MODEL_ID;
  const match = BASE_T2I_MODELS.find((m) => m.id === raw);
  return match?.id ?? DEFAULT_BASE_T2I_MODEL_ID;
}

export function getBaseT2iModelSpec(id: ShortsBaseT2iModelId): ShortsBaseT2iModelSpec {
  const spec = BASE_T2I_MODELS.find((m) => m.id === id);
  if (!spec) {
    // Per QA finding M10: the previous `!` non-null assertion produced
    // a vague "Cannot read properties of undefined" if a future refactor
    // ever passed a raw string here without `resolveBaseT2iModelId`
    // first. Explicit throw gives a greppable error message.
    throw new Error(`Unknown base T2I model id: "${id}". Use resolveBaseT2iModelId() to sanitise input first.`);
  }
  return spec;
}
