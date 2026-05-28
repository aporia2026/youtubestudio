/**
 * Doodle Explainer 2 — Character Bible prompt augmentation.
 *
 * Phase 2 of the doodle_explainer_2 cache work. The character cache
 * (Phase 1) anchors ONE character's identity per row via Atlas Edit on
 * the cached base. Multi-character rows still drift on the non-anchored
 * characters — Atlas Edit preserves only one source image's content per
 * call.
 *
 * The bible solves that gap with prompt augmentation: the LLM emits a
 * per-doc `character_descriptions` map at doc-gen time (1-2 sentence
 * visual description per character_id slug), and the dispatcher
 * prepends those descriptions to every row's prompt as a reference
 * block. Even for characters the cache can't anchor on a given row,
 * the model has consistent reference language ("Jennie wears a yellow
 * dress with a brown apron, brown hair pulled back") so she renders
 * the same way across non-consecutive shots.
 *
 * Pure / client-friendly / no IO — safe to import from any module.
 *
 * Spec: _plans/2026-05-28-doodle-2-character-bible.md.
 */

export type CharacterDescriptions = Record<string, string>;

/** Build the "character bible" prefix block from a description map.
 *  Empty / undefined / null inputs return an empty string so the caller
 *  can unconditionally prepend.
 *
 *  Output format — a labeled reference block at the top of the prompt
 *  that primes the model BEFORE the scene body:
 *
 *    Character reference for this scene:
 *    - george: <description>
 *    - jennie: <description>
 *
 *    <user's ai_image_prompt follows>
 *
 *  Keys (slugs) are included verbatim — they're the same identifiers
 *  the LLM uses on `character_id` so the model can match them to the
 *  characters its own prompt mentions. */
export function buildCharacterBiblePrefix(
  descriptions: CharacterDescriptions | undefined | null,
): string {
  if (!descriptions) return '';
  const entries = Object.entries(descriptions).filter(
    ([slug, desc]) =>
      typeof slug === 'string'
      && slug.trim().length > 0
      && typeof desc === 'string'
      && desc.trim().length > 0,
  );
  if (entries.length === 0) return '';
  const lines = entries.map(([slug, desc]) => `- ${slug}: ${desc.trim()}`);
  return `Character reference for this scene:\n${lines.join('\n')}\n\n`;
}

/** Convenience: prepend the bible to an existing prompt. Returns the
 *  prompt unchanged when the descriptions map is empty / missing. */
export function prependCharacterBible(
  prompt: string,
  descriptions: CharacterDescriptions | undefined | null,
): string {
  const prefix = buildCharacterBiblePrefix(descriptions);
  if (!prefix) return prompt;
  return `${prefix}${prompt}`;
}
