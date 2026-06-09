/**
 * Client-safe slice of `shorts-base-t2i.ts` — types, the model
 * registry, and the pure resolver/lookup helpers. Lives in its own
 * module so client components (the batch RetryAssetsPicker, the
 * editor's base-model picker) can import it without dragging the
 * server-only image generators (sharp, atlas, kie) into the browser
 * bundle.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Mirrors the existing `shorts-types.ts` ↔ `shorts.ts` and
 * `shorts-batch-stages.ts` ↔ `shorts-batch-orchestrator.ts` splits.
 */

/** Every base T2I model the picker can target. Keep this union in
 *  lockstep with `BASE_T2I_MODELS` below so `resolveBaseT2iModelId`
 *  can narrow at runtime without an unsafe cast. */
export type ShortsBaseT2iModelId =
  | 'atlas-gpt-image-2'
  | 'kie-gpt-image-2'
  | 'kie-nano-banana-2'
  | 'kie-flux-2-pro';

export interface ShortsBaseT2iModelSpec {
  id: ShortsBaseT2iModelId;
  /** Short display label for the dropdown. */
  label: string;
  /** Vendor identifier ('atlas' | 'kie'). */
  vendor: 'atlas' | 'kie';
  /** Flat per-call cost USD. Tracked locally because Kie's invoice
   *  arrives async; this is the audit-row estimate the caller logs. */
  costUsd: number;
  /** Underlying model id Kie / Atlas expects on the wire. */
  modelSlug: string;
  /** Short one-liner shown under the option to help the user pick. */
  hint: string;
}

export const BASE_T2I_MODELS: readonly ShortsBaseT2iModelSpec[] = Object.freeze([
  {
    id: 'atlas-gpt-image-2',
    label: 'Atlas GPT Image 2',
    vendor: 'atlas',
    costUsd: 0.009,
    modelSlug: 'openai/gpt-image-2/text-to-image',
    hint: 'Cost-optimal default. Same OpenAI model as Kie GPT-2 but cheaper.',
  },
  {
    id: 'kie-gpt-image-2',
    label: 'Kie GPT Image 2',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'gpt-image-2-text-to-image',
    hint: 'Sibling of Atlas above (same OpenAI model, different vendor). 5× cost; kept for vendor parity.',
  },
  {
    id: 'kie-nano-banana-2',
    label: 'Nano Banana 2',
    vendor: 'kie',
    costUsd: 0.04,
    modelSlug: 'nano-banana-2',
    hint: 'Google Gemini 3.1 Flash Image — different visual style than GPT Image 2.',
  },
  {
    id: 'kie-flux-2-pro',
    label: 'Flux 2 Pro',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'flux-2/pro-text-to-image',
    hint: 'Black Forest Labs Flux 2 — different model family, typically richer composition.',
  },
]);

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
  // Non-null because the type union and BASE_T2I_MODELS are kept in
  // lockstep at module load.
  return BASE_T2I_MODELS.find((m) => m.id === id)!;
}
