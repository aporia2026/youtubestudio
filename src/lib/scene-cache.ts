/**
 * Doodle Explainer 2 — per-doc scene/location cache (client-friendly helpers).
 *
 * Phase 3 of the doodle_explainer_2 cache work. Mirrors
 * `src/lib/character-cache.ts` exactly — same shape, same first-
 * occurrence-wins semantics, same client-friendly purity — but anchors
 * a recurring LOCATION (`scene_id`) instead of a recurring CHARACTER
 * (`character_id`). Fixes the "different house each shot" drift the
 * Sodder QA on doc b59e88ad flagged after Phase 1 closed the character
 * side.
 *
 * Spec: _plans/2026-05-28-doodle-2-scene-cache.md.
 */

/** Per-scene cache entry. The base_url is the canonical i2i output for
 *  the FIRST row that featured this location/object; every subsequent
 *  row with the same scene_id reuses this URL as the Atlas Edit input
 *  so the rendered location stays consistent across the doc. */
export interface SceneCacheEntry {
  base_url: string;
  first_seen_row_index: number;
}

export type SceneCache = Record<string, SceneCacheEntry>;

/** Wrap a row's raw `ai_image_prompt` into an Atlas-Edit instruction
 *  that preserves the location's identity from the cached base image
 *  while letting characters / actions / atmospheric elements change.
 *
 *  Pure function — no IO, safe to import from any module. Wording
 *  parallels `buildCharacterContinuationEditPrompt` in
 *  `src/lib/character-cache.ts` but emphasizes architectural / palette
 *  / structural preservation rather than face / hair / clothing
 *  preservation. */
export function buildSceneContinuationEditPrompt(originalScenePrompt: string): string {
  const trimmed = originalScenePrompt.trim();
  return (
    `Modify this image to keep the SAME location / setting in this new beat: ${trimmed}. ` +
    `CRITICAL: keep the location's architecture, exterior shape, window layout, ` +
    `color palette, and overall identity EXACTLY identical to the input image. ` +
    `Only change the characters present, their poses, the action, and atmospheric ` +
    `elements (smoke, fire, lighting, weather) per the new scene description above. ` +
    `Maintain the hand-drawn doodle style with thick uneven black ink outlines ` +
    `and flat color fills.`
  );
}

/** Look up the cached base URL for a scene. Returns undefined when the
 *  cache is empty / missing or the scene_id has no entry yet (the row
 *  should run a fresh i2i and write back to the cache). */
export function getCachedSceneBase(
  cache: SceneCache | undefined | null,
  sceneId: string,
): string | undefined {
  if (!cache) return undefined;
  if (!sceneId.trim()) return undefined;
  return cache[sceneId]?.base_url;
}

/** Insert a scene into the cache, preserving the canonical base.
 *
 *  First-occurrence-wins (same rule as character-cache). Once a scene
 *  has a base, later rows reuse THAT base via Atlas Edit. Overwriting
 *  a populated entry would let the canonical location drift mid-doc,
 *  which is the exact failure mode the cache exists to prevent.
 *
 *  Returns a NEW object — never mutates the input. */
export function writeSceneToCache(
  cache: SceneCache | undefined | null,
  sceneId: string,
  baseUrl: string,
  rowIndex: number,
): SceneCache {
  const next: SceneCache = { ...(cache ?? {}) };
  if (!sceneId.trim() || !baseUrl.trim()) return next;
  if (next[sceneId]) return next;
  next[sceneId] = { base_url: baseUrl, first_seen_row_index: rowIndex };
  return next;
}
