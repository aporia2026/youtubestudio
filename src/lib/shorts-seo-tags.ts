/**
 * Pure, client-safe YouTube TAGS helpers split out of `shorts-seo.ts`
 * so client components (the bulk-batch inspector + `ShortSeoResults`)
 * can import the budget-math without dragging the server-only AI /
 * model-defaults / next/headers chain into the browser bundle.
 *
 * Mirrors the `shorts-types.ts` ↔ `shorts.ts` and `shorts-base-t2i-
 * types.ts` ↔ `shorts-base-t2i.ts` split pattern used elsewhere.
 *
 * The server-side `shorts-seo.ts` re-exports these so callers there
 * don't need to know about the split.
 *
 * Plan: _plans/2026-06-09-bulk-shorts-robustness-and-inspector.md.
 */

/** Hard YouTube API limits for the tags metadata field. Mirror these
 *  in the inspector char-budget indicator so users see green here when
 *  the upload will accept the row. */
export const YT_MAX_TAGS = 30;
export const YT_MAX_TAG_LENGTH = 100;
export const YT_MAX_COMBINED_LENGTH = 500;

/** Compute the combined-length the YouTube API uses for the 500-char
 *  budget. Includes:
 *    - each tag's character count
 *    - 2 wrapping quotes per tag containing a space (multi-word tags
 *      need quoting in the wire format, costing 2 extra chars)
 *    - 2 chars (', ') per separator between adjacent tags
 *  This is conservative — it never undercounts what YouTube enforces. */
export function combinedYoutubeTagsLength(tags: readonly string[]): number {
  if (tags.length === 0) return 0;
  let sum = 0;
  for (const tag of tags) {
    sum += tag.length;
    if (/\s/.test(tag)) sum += 2;
  }
  sum += (tags.length - 1) * 2;
  return sum;
}

/** Characters YouTube rejects in tag values:
 *  - `<` and `>` (silently dropped, can cascade into 400)
 *  - ASCII control characters (0x00–0x1F, 0x7F)
 *  - Smart angle quotes (« »)
 *  Strip these upfront so the LLM occasionally including a
 *  "tag1 → tag2" or smart-quoted phrase doesn't fail the upload
 *  later with a confusing YouTube error. Per QA finding M6. */
const YT_REJECTED_CHARS = /[<>«»\x00-\x1F\x7F]/g;

/** Normalise the YouTube TAGS array. Pure — exported for testing.
 *  Strips '#' if the LLM ignored the prompt, strips YouTube-rejected
 *  characters, drops blanks, dedupes case-insensitive (YouTube treats
 *  "USPS scam" and "usps scam" as the same tag), caps each tag at 100
 *  chars (YouTube's hard limit per-tag), and caps the whole array at
 *  30 tags. Finally drops from the END until combined-length fits the
 *  500-char total budget — the LLM orders by relevance so trimming
 *  the tail preserves the highest-value tags. Allows internal
 *  whitespace (multi-word phrases are the whole point of tags vs
 *  hashtags). */
export function normaliseYoutubeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .trim()
      .replace(/^#+/, '')
      .replace(YT_REJECTED_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, YT_MAX_TAG_LENGTH);
    if (!cleaned) continue;
    if (cleaned.toLowerCase() === 'shorts') continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= YT_MAX_TAGS) break;
  }
  while (out.length > 0 && combinedYoutubeTagsLength(out) > YT_MAX_COMBINED_LENGTH) {
    out.pop();
  }
  return out;
}
