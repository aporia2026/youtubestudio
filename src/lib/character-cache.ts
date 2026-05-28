/**
 * Doodle Explainer 2 — per-doc character cache (client-friendly helpers).
 *
 * Phase 1 wired the cache write/read into the auto-pipeline image-gen
 * stage. Phase 1.5 made the LLM emit `character_id` reliably. Phase 1.6
 * (Bug D) finally connects the cache to the manual editor's image-gen
 * path so Atlas Edit reuse fires on the surface the user actually uses.
 *
 * What this module owns:
 *   - The wrapped Atlas-Edit prompt that preserves character identity
 *     while changing the scene around the character.
 *   - The cache read/write helpers — pure functions over the JSONB blob
 *     so both the auto-pipeline and the manual editor can share them
 *     without crossing the auto-pipeline / app-route boundary (the
 *     auto-pipeline module pulls in server-only deps like
 *     `generateAtlasEdit`, which is why the production-doc page can't
 *     import it directly).
 *
 * What this module does NOT own:
 *   - The Atlas Edit HTTP call itself. The manual editor dispatches via
 *     the existing `/api/generate/production-doc/image/edit` route
 *     (same route the variant pipeline uses). The auto-pipeline still
 *     calls `generateAtlasEdit` directly via
 *     `generateCharacterContinuationImage` in
 *     `src/lib/auto-pipeline/production-doc-image-gen.ts`.
 *
 * Spec: _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-D).
 */

/** Per-character cache entry. The base_url is the canonical i2i output
 *  for the FIRST row that featured this character; every subsequent row
 *  with the same character_id reuses this URL as the Atlas Edit input
 *  so the rendered identity stays consistent across the doc. */
export interface CharacterCacheEntry {
  base_url: string;
  first_seen_row_index: number;
}

export type CharacterCache = Record<string, CharacterCacheEntry>;

/** Wrap a row's raw `ai_image_prompt` into an Atlas-Edit instruction
 *  that preserves the character's identity from the cached base image
 *  while changing the scene around them.
 *
 *  Pure function — no IO, safe to import from any module. Format
 *  matches the smoke-test prompt that successfully preserved George's
 *  face/hair/clothing across pose changes
 *  (_plans/2026-05-28-atlas-edit-smoke/). If a future iteration of
 *  Atlas Edit needs different language (e.g. it starts drifting on
 *  long prompts), tune here. */
export function buildCharacterContinuationEditPrompt(originalScenePrompt: string): string {
  const trimmed = originalScenePrompt.trim();
  return (
    `Modify this image to show the SAME character in this new scene: ${trimmed}. ` +
    `CRITICAL: keep the character's face, hair, body proportions, clothing, ` +
    `and overall identity EXACTLY identical to the input image. Only change ` +
    `the pose, setting, expression, and other scene elements per the new ` +
    `scene description above. Maintain the hand-drawn doodle style with ` +
    `thick uneven black ink outlines and flat color fills.`
  );
}

/** Look up the cached base URL for a character. Returns undefined when
 *  the cache is empty / missing or the character_id has no entry yet
 *  (the row should run a fresh i2i and write back to the cache). */
export function getCachedCharacterBase(
  cache: CharacterCache | undefined | null,
  characterId: string,
): string | undefined {
  if (!cache) return undefined;
  if (!characterId.trim()) return undefined;
  return cache[characterId]?.base_url;
}

/** Insert a character into the cache, preserving the canonical base.
 *
 *  The cache is "first-occurrence wins" — once a character has a base,
 *  later rows reuse THAT base via Atlas Edit. Overwriting a populated
 *  entry would let the canonical identity drift mid-doc, which is the
 *  exact failure mode the cache exists to prevent. So if the entry
 *  already exists this returns the cache unchanged.
 *
 *  Returns a NEW object — never mutates the input. Callers pass the
 *  result to `setDoc` (manual editor) or persist via the artefact's
 *  metadata_jsonb patch (auto-pipeline). */
export function writeCharacterToCache(
  cache: CharacterCache | undefined | null,
  characterId: string,
  baseUrl: string,
  rowIndex: number,
): CharacterCache {
  const next: CharacterCache = { ...(cache ?? {}) };
  if (!characterId.trim() || !baseUrl.trim()) return next;
  if (next[characterId]) return next;
  next[characterId] = { base_url: baseUrl, first_seen_row_index: rowIndex };
  return next;
}
