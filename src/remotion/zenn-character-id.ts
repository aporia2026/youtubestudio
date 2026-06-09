/**
 * Pure slug normalization for zenn_v1 character ids. Shared between
 * the pipeline stage (which writes bank entries) and the renderer
 * (which reads them). Co-located in `src/remotion/` next to the
 * other pure modules (`canvas-reveal-math`, `zenn-label-parse`)
 * because Remotion bundles can import from here cleanly, and the
 * pipeline stage already imports renderer-side pure modules.
 *
 * Why a shared module:
 *   QA pass 2026-06-10 found a latent bug where the pipeline writes
 *   the bank under the raw `canonicalId` (the first row's verbatim
 *   slug, e.g., "Knight") while the planner dedupes by the
 *   normalized form ("knight"). If a later row emits the same
 *   character with different case ("knight"), the row's renderer
 *   lookup hits `bank["knight"]` which is undefined and the
 *   character layer silently drops.
 *
 *   The fix: both write and read sides go through the same
 *   normalizer. Bank entries get stored under the normalized key,
 *   and every renderer lookup re-normalizes the incoming slug. Two
 *   rows that meant the same character render the same character
 *   regardless of how the LLM cased the slug.
 */

/** Normalize a `zenn_character_id` slug for stable bank lookup.
 *  Lowercase + replace any non-alphanumeric run with a single
 *  hyphen + trim leading / trailing hyphens. Two slugs that
 *  normalize to the same value MUST refer to the same character.
 *
 *  Pure: no IO. */
export function normalizeZennCharacterId(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
