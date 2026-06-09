/**
 * Shared type + helpers for the multi-variant thumbnail generation flow.
 *
 * Background:
 *   Pre-2026-06-09, every thumbnail format produced a single image URL
 *   stored in the format payload (`imageUrl: string`). With 3-variant
 *   generation, each payload now carries a `variants` array and a
 *   `selectedVariantIndex` pointing at the user's pick. The legacy
 *   `imageUrl` field is kept on the payload for backwards-compat so
 *   entries saved before the migration keep rendering — see
 *   `getSelectedVariantUrl()` for the resolution order.
 *
 *   Architecture / rollout plan:
 *   `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`.
 */

export interface ThumbnailVariant {
  /** Stable id within an entry — `v0`, `v1`, `v2`. React key and the
   *  address for "regenerate this slot" / "select this one" callbacks. */
  id: string;
  /** Final image URL (R2 / Vercel Blob). Empty string when the
   *  provider call failed; the picker renders an empty slot with a
   *  retry button in that case. */
  imageUrl: string;
  /** Full prompt sent to the image model for this specific variant.
   *  Persisted so the user can see what differed between variants and
   *  so "variant 2 looks identical to variant 1" debugging doesn't
   *  require server logs. */
  promptUsed: string;
  /** Short human-readable label from the LLM concept step, e.g.
   *  "Character on left, hook word right". Surfaced in the picker
   *  underneath each thumbnail. Optional because the free-form flow
   *  generates variants from a single user-supplied prompt and has
   *  no LLM concept step to populate this. */
  conceptLabel?: string;
  /** Estimated USD cost for this variant's image generation. Set by
   *  the route after the provider call lands. Telemetry only; not
   *  displayed to end users. */
  costEstimateUsd?: number;
  /** ms-epoch timestamp when this variant's image generation completed.
   *  Useful when one variant takes much longer than the others (e.g.
   *  Kie queue contention) so the UI can show a relative "took 12s"
   *  hint in dev mode. */
  completedAt?: number;
}

/**
 * Structural-typing constraint for any thumbnail history payload that
 * carries variants + a selection. Keeps `getSelectedVariantUrl` decoupled
 * from the discriminated-union of format payloads in `history.ts`.
 */
export interface VariantBearingPayload {
  variants?: ThumbnailVariant[];
  selectedVariantIndex?: number;
  /** Legacy field. Entries saved before the variants migration store
   *  the single generated image here and leave `variants` undefined. */
  imageUrl?: string;
}

/**
 * Returns the image URL the consumer should display / download / feed
 * into the schedule + post flow. Resolution order:
 *
 *   1. `variants[selectedVariantIndex].imageUrl` (the user's pick)
 *   2. The first non-empty `variants[].imageUrl` (fallback when the
 *      selected variant's gen failed but a sibling succeeded)
 *   3. Legacy `imageUrl` (entries saved before the variants migration)
 *   4. Empty string (nothing usable — caller decides what to render)
 *
 * Intentionally non-throwing — the downstream schedule/post pipeline
 * must not crash on a malformed or partially-failed entry.
 */
export function getSelectedVariantUrl(payload: VariantBearingPayload | null | undefined): string {
  if (!payload) return '';
  const { variants, selectedVariantIndex, imageUrl } = payload;
  if (variants && variants.length > 0) {
    const idx = Math.max(0, Math.min(selectedVariantIndex ?? 0, variants.length - 1));
    const picked = variants[idx]?.imageUrl;
    if (picked) return picked;
    const firstGood = variants.find(v => v.imageUrl);
    if (firstGood) return firstGood.imageUrl;
  }
  return imageUrl ?? '';
}

/**
 * Constructs a `ThumbnailVariant` from an image-gen result. Used by
 * every route that fans out to N variants. Centralised so the id /
 * timestamp / cost-tracking shape stays consistent across providers.
 */
export function buildVariant(input: {
  index: number;
  imageUrl: string;
  promptUsed: string;
  conceptLabel?: string;
  costEstimateUsd?: number;
}): ThumbnailVariant {
  return {
    id: `v${input.index}`,
    imageUrl: input.imageUrl,
    promptUsed: input.promptUsed,
    conceptLabel: input.conceptLabel,
    costEstimateUsd: input.costEstimateUsd,
    completedAt: Date.now(),
  };
}

/**
 * Hard ceiling on variant count, enforced at the route layer. 3 is the
 * product spec ("user picks one of 3"); the cap prevents a malformed
 * request from triggering a 10x cost spike on the paid image-gen lane.
 */
export const MAX_VARIANT_COUNT = 3;
export const DEFAULT_VARIANT_COUNT = 3;
export const MIN_VARIANT_COUNT = 1;

/** Clamp helper used by route + settings + page. */
export function clampVariantCount(n: number | undefined | null): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_VARIANT_COUNT;
  return Math.max(MIN_VARIANT_COUNT, Math.min(MAX_VARIANT_COUNT, Math.floor(n)));
}
