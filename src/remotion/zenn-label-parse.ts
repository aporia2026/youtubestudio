/**
 * Pure parser for the `[hl]word[/hl]` highlighter markers the
 * zenn_v1 LLM emits inside `on_screen_text`. No React, no Remotion
 * imports — safe to import from anywhere (renderer, tests, anything
 * else that needs to know how a label decomposes into segments).
 *
 * Marker shape (PR 1 of `_plans/2026-06-10-zenn-v1-style.md`):
 *
 *   "EVERYONE. [hl]ALL AT ONCE[/hl]."
 *
 * Splits into three segments:
 *   { text: "EVERYONE. ",  highlighted: false }
 *   { text: "ALL AT ONCE", highlighted: true  }
 *   { text: ".",           highlighted: false }
 *
 * The renderer renders highlighted segments inside an inline span
 * with the yellow translucent stripe behind them; non-highlighted
 * segments render unstyled.
 *
 * Malformed input (open marker without close, nested markers,
 * stray closing markers) renders the literal characters verbatim —
 * the user can fix the markup in the row JSON without the renderer
 * silently swallowing characters.
 */

export interface ZennLabelSegment {
  text: string;
  highlighted: boolean;
}

/** Split a label string into highlighted vs unhighlighted segments.
 *  Always returns at least one segment (empty input returns one
 *  segment with empty text). Pure: no IO, no globals. */
export function parseZennLabel(raw: string | undefined | null): ZennLabelSegment[] {
  if (raw === undefined || raw === null) return [{ text: '', highlighted: false }];
  if (typeof raw !== 'string') return [{ text: '', highlighted: false }];
  if (raw.length === 0) return [{ text: '', highlighted: false }];

  const segments: ZennLabelSegment[] = [];
  // Pattern matches one `[hl]...[/hl]` pair. The inner capture
  // group `([^[]*?)` refuses `[` so a stray `[hl]` later in the
  // string can't get absorbed into the inner of an earlier pair.
  // Greedy `?` keeps it lazy.
  const pattern = /\[hl\]([^[]*?)\[\/hl\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const matchStart = match.index;
    if (matchStart > cursor) {
      segments.push({
        text: raw.slice(cursor, matchStart),
        highlighted: false,
      });
    }
    const innerText = match[1];
    // Empty `[hl][/hl]` markers contribute nothing — they're noise
    // in the markup but shouldn't render an empty span. Skip.
    if (innerText.length > 0) {
      segments.push({ text: innerText, highlighted: true });
    }
    cursor = matchStart + match[0].length;
  }
  // Trailing unhighlighted text after the last (or only) match.
  if (cursor < raw.length) {
    segments.push({
      text: raw.slice(cursor),
      highlighted: false,
    });
  }
  // No matches at all → one unhighlighted segment carrying the
  // whole input. This also covers the "malformed markers"
  // contract: `[hl]oops` (no closing tag) just renders verbatim.
  if (segments.length === 0) {
    segments.push({ text: raw, highlighted: false });
  }
  return segments;
}

/** Apply the canonical 0.65 translucent alpha to a hex color for use
 *  as a highlighter background. Stored hex must already be a clean
 *  `#RRGGBB`; malformed inputs return the default Zenn yellow at
 *  0.65 alpha so the renderer never produces a broken color value.
 *
 *  Exported separately so the renderer + tests share one
 *  source-of-truth for the alpha. */
export function highlighterRgba(hex: string | undefined): string {
  const fallback = 'rgba(255, 232, 64, 0.65)';
  if (!hex || typeof hex !== 'string') return fallback;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.65)`;
}
