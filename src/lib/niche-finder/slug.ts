/**
 * Niche slug normalisation.
 *
 * The slug is the cache key. Two operators typing "Personal Finance"
 * vs "personal-finance" must collapse to the same slug so the cache
 * hits. The slug also has to be safe to put in a URL.
 *
 * Pure function so the route handler and the test fixtures agree on
 * what "the same niche" means.
 */

/** Maximum bytes a slug can occupy in the DB row + URL. 80 is wide
 *  enough for any real niche and narrow enough that the
 *  `(workspace_id, slug)` index doesn't bloat. */
const MAX_SLUG_LENGTH = 80;

/** Normalise free-text niche input into a URL-safe slug.
 *
 *  - Lowercases everything.
 *  - Strips diacritics so "café" and "cafe" collapse.
 *  - Replaces any run of non-alphanumerics with a single hyphen.
 *  - Trims leading/trailing hyphens.
 *  - Caps length at 80 bytes.
 *  - Returns 'untitled-niche' for input that normalises to empty
 *    (all-punctuation, all-whitespace) so the slug is always a
 *    valid PK component. */
export function slugifyNiche(input: string): string {
  if (typeof input !== 'string') return 'untitled-niche';
  const stripped = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) return 'untitled-niche';
  return slug.length > MAX_SLUG_LENGTH ? slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') : slug;
}

/** Best-effort niche name normalisation for display. Collapses
 *  consecutive whitespace and trims; preserves casing. Length cap
 *  at 120 chars so the UI doesn't get a paragraph as a "name". */
export function normalizeNicheName(input: string): string {
  if (typeof input !== 'string') return 'Untitled niche';
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'Untitled niche';
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}
