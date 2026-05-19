// Search + ranking helpers for model pickers and the Settings → Model
// Defaults panel. Hand-rolled because:
//   - the haystacks are short (model names, scope labels) and a real fuzzy
//     matcher (Levenshtein / FZF) introduces false positives more often
//     than it helps;
//   - zero new dependencies;
//   - the rules are easy to read, so the ordering is predictable to users.
//
// All exports are pure functions. They never touch the DOM or React.

import type { AIModel } from './ai-models';

/** Lower-case, split on whitespace, drop empties. Cheap and stable. */
export function tokens(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** Multi-token AND. Every token must appear somewhere in haystack
 *  (case-insensitive). Empty query always matches. */
export function matches(query: string, haystack: string): boolean {
  const ts = tokens(query);
  if (ts.length === 0) return true;
  const hay = haystack.toLowerCase();
  return ts.every((t) => hay.includes(t));
}

/** Same as `matches` but the haystack is built from several fields so a
 *  caller can do `matchesAny(q, name, id, description)` without paying for
 *  string concatenation when the query is empty. */
export function matchesAny(query: string, ...haystacks: Array<string | null | undefined>): boolean {
  const ts = tokens(query);
  if (ts.length === 0) return true;
  const joined = haystacks.filter(Boolean).join('  ').toLowerCase();
  return ts.every((t) => joined.includes(t));
}

/** Rank a model record against a query. Higher is better.
 *
 *  Heuristic — designed so that typing the start of a model's name pins it
 *  to the top, while typing a substring still surfaces it:
 *    +100  exact full-name match
 *    +60   name starts with the full query
 *    +30   every token starts a word in the name
 *    +15   every token appears in the name
 *    +6    every token appears in the id
 *    +2    every token appears in the description
 *    +1    every token appears in the provider
 *      0   no match — caller filters out
 *
 *  Empty query returns 1 (match, no preference) so callers can keep using
 *  the same sort/filter pipeline without branching. */
export function rankModel(query: string, model: AIModel): number {
  const ts = tokens(query);
  if (ts.length === 0) return 1;
  const name = model.name.toLowerCase();
  const id = model.id.toLowerCase();
  const description = (model.description || '').toLowerCase();
  const provider = model.provider.toLowerCase();
  const q = ts.join(' ');

  if (name === q) return 100;
  if (name.startsWith(q)) return 60;

  // token-start-of-word: every token must begin a word in the name.
  const nameWords = name.split(/[\s\-_/.]+/).filter(Boolean);
  const everyTokenStartsAWord = ts.every((t) => nameWords.some((w) => w.startsWith(t)));
  if (everyTokenStartsAWord) return 30;

  if (ts.every((t) => name.includes(t))) return 15;
  if (ts.every((t) => id.includes(t))) return 6;
  if (ts.every((t) => description.includes(t))) return 2;
  if (ts.every((t) => provider.includes(t))) return 1;
  return 0;
}

/** Split `text` into alternating match / non-match segments, suitable for
 *  rendering with `<strong>` (or any bold style) on the matched parts.
 *  Matches are case-insensitive and resolved left-to-right against the
 *  union of query tokens. Overlapping matches collapse into one segment. */
export function highlight(query: string, text: string): Array<{ text: string; match: boolean }> {
  const ts = tokens(query);
  if (ts.length === 0 || !text) return [{ text, match: false }];

  const lower = text.toLowerCase();
  // Collect [start, end) ranges for every token occurrence.
  const ranges: Array<[number, number]> = [];
  for (const t of ts) {
    if (!t) continue;
    let from = 0;
    while (from <= lower.length - t.length) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      ranges.push([idx, idx + t.length]);
      from = idx + t.length;
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  // Merge overlapping ranges.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const [s, e] = ranges[i];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  // Walk the original text, alternating non-match / match segments.
  const out: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: text.slice(cursor, s), match: false });
    out.push({ text: text.slice(s, e), match: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}
