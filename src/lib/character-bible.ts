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

// ─── Phase 4 (Editor UI) — collectors ───────────────────────────────────────
//
// The editor's per-row chips need to know which character_id / scene_id
// slugs are already in use across the doc (the dropdown options), and
// the descriptions panel needs to know which slugs are TAGGED but
// MISSING from `character_descriptions` (so it can show a warning).
//
// Pure / no IO. Walks rows once; safe to wrap in useMemo on the doc.

interface SlugTallyRow {
  character_id?: string;
  scene_id?: string;
}

/** Sorted-unique list of `character_id` slugs in use across the doc.
 *  Empty / whitespace values are dropped. */
export function collectCharacterIds(rows: ReadonlyArray<SlugTallyRow>): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const slug = r.character_id;
    if (typeof slug === 'string' && slug.trim().length > 0) seen.add(slug);
  }
  return Array.from(seen).sort();
}

/** Sorted-unique list of `scene_id` slugs in use across the doc. */
export function collectSceneIds(rows: ReadonlyArray<SlugTallyRow>): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const slug = r.scene_id;
    if (typeof slug === 'string' && slug.trim().length > 0) seen.add(slug);
  }
  return Array.from(seen).sort();
}

/** Per-slug tally — how many rows carry a given `character_id`. Useful
 *  for the dropdown's secondary label ("george · 4 rows") so the user
 *  can see at a glance which slug they're about to attach to. */
export function tallyCharacterIds(rows: ReadonlyArray<SlugTallyRow>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const slug = r.character_id;
    if (typeof slug === 'string' && slug.trim().length > 0) {
      tally[slug] = (tally[slug] ?? 0) + 1;
    }
  }
  return tally;
}

/** Same for `scene_id`. */
export function tallySceneIds(rows: ReadonlyArray<SlugTallyRow>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const slug = r.scene_id;
    if (typeof slug === 'string' && slug.trim().length > 0) {
      tally[slug] = (tally[slug] ?? 0) + 1;
    }
  }
  return tally;
}

/** Slugs that appear on rows but have NO entry in
 *  `character_descriptions`. Surfaces in the doc-level panel with a
 *  warning so the user can add the missing description.
 *
 *  An entry with an empty / whitespace description counts as missing —
 *  the bible builder filters those out anyway, so for the user's
 *  intent there's no difference between "missing key" and "empty
 *  value". */
export function findUntaggedDescriptions(
  rows: ReadonlyArray<SlugTallyRow>,
  descriptions: CharacterDescriptions | undefined | null,
): string[] {
  const usedSlugs = collectCharacterIds(rows);
  return usedSlugs.filter((slug) => {
    const desc = descriptions?.[slug];
    return typeof desc !== 'string' || desc.trim().length === 0;
  });
}

/** Validate a slug at the editor input boundary. Returns null when the
 *  slug is acceptable; returns a human-readable reason when it isn't.
 *  Used by the per-row chips to gate the "save" action and surface a
 *  tooltip on invalid input.
 *
 *  Rules mirror the LLM's slug convention: lowercase letters, digits,
 *  and dashes; must start with a letter or digit; max 50 chars (the
 *  cache-key contract on the server side has no hard cap but anything
 *  longer is almost certainly typed in error). */
export function validateSlug(slug: string): string | null {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return 'Slug can\'t be empty.';
  if (trimmed.length > 50) return 'Slug is too long (max 50 characters).';
  if (!/^[a-z0-9]/.test(trimmed)) return 'Slug must start with a lowercase letter or digit.';
  if (!/^[a-z0-9-]+$/.test(trimmed)) return 'Slug can only contain lowercase letters, digits, and dashes.';
  if (/-$/.test(trimmed)) return 'Slug can\'t end with a dash.';
  return null;
}
