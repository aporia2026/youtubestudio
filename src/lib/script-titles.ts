// ---------------------------------------------------------------------------
// Deterministic title extraction for video scripts.
//
// The production-doc generator used to ask the LLM to detect `##Heading`
// section markers and split them into Title Card + content rows. That
// detection was unreliable: a 6-title script could come back with 4 titles
// rendered and 2 silently dropped, and the chunk-boundary rule at
// prompts.ts:2225 actively suppressed Title Cards on continuation chunks.
//
// This module replaces that with a regex-based pre-pass. Headings are
// extracted server-side, the script the LLM sees has each heading line
// replaced by a `<<TITLE_N>>` sentinel, and the LLM is instructed to emit
// exactly one Title Card row per sentinel. The post-validator in the route
// compares what was extracted against what the LLM emitted.
//
// Why sentinels (not character offsets):
//   Offsets drift the moment any text is edited or chunked. Sentinels
//   survive transformations — they are stable tokens that the LLM is told
//   to preserve and that we can grep for unambiguously.
// ---------------------------------------------------------------------------

export interface ExtractedTitle {
  /** The heading text, trimmed (e.g. "Wana Decrypt0r 2.0"). */
  text: string;
  /** The sentinel placed where the heading line was (e.g. "<<TITLE_0>>"). */
  sentinel: string;
}

export interface ExtractedScript {
  /** Script with each `##Heading` line replaced by its sentinel. */
  stripped: string;
  /** Titles in the order they appeared in the input. */
  titles: ExtractedTitle[];
  /** Non-fatal issues (cap reached, length-truncated title, etc.). */
  warnings: string[];
}

/** Maximum number of titles extracted per script. Extra `##` lines beyond
 *  this stay in the stripped script as plain text. Guards against a script
 *  full of `##` lines blowing up the prompt. */
const MAX_TITLES = 50;

/** Maximum heading text length. Longer headings are truncated and a warning
 *  is emitted. Guards against pasting a whole paragraph after `##`. */
const MAX_TITLE_CHARS = 200;

/** Recognises `## Heading` and `##Heading` but NOT `### Subheading`.
 *  - `^##` anchored at start of line.
 *  - `(?!#)` rejects 3+ hashes.
 *  - `\s*` optional whitespace after `##` (so `##NoSpace` and `## With Space` both match).
 *  - `(.+?)` lazy capture of the heading text.
 *  - `\s*$` allows trailing whitespace, end-anchored. */
const HEADING_RE = /^##(?!#)\s*(.+?)\s*$/;

/** Detects ` ``` ` fenced code blocks. Toggling state on each match means
 *  any `##` inside a code block is preserved as-is, never extracted. */
const FENCE_RE = /^\s*```/;

/** Stopwords that don't have to be capitalized in a title — keeps the
 *  title-case heuristic from rejecting natural titles like "The Mary
 *  Celeste" or "A Voice in the Dark." */
const TITLE_CASE_STOPWORDS = new Set<string>([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'for', 'yet', 'so',
  'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'is',
  'into', 'over', 'with', 'from', 'onto', 'upon', 'than',
]);

/** Heuristic title detection for plain-text scripts. Matches lines that
 *  LOOK like a section heading even without a `##` prefix:
 *
 *   - blank line above (or beginning of file)
 *   - 3-60 characters
 *   - 1-10 words
 *   - no sentence-terminating punctuation at the end
 *   - at least half the words (ignoring stopwords) start uppercase, OR
 *     the whole line is upper-case
 *   - the line below is non-blank prose of at least 25 chars (a real
 *     section body — guards against catching a one-line aside as a title)
 *
 *  The next-line length test is the most important false-positive guard.
 *  Without it, "He said yes" on its own line would qualify.
 */
const HEURISTIC_MIN_CHARS = 3;
const HEURISTIC_MAX_CHARS = 60;
const HEURISTIC_MAX_WORDS = 10;
const HEURISTIC_NEXT_LINE_MIN_CHARS = 25;
const SENTENCE_END_CHARS = new Set<string>(['.', '!', '?', ',', ';', ':']);

export function looksLikePlainTextHeading(
  current: string,
  lineAbove: string | null,
  lineBelow: string | null,
): boolean {
  const trimmed = current.trim();
  if (trimmed.length < HEURISTIC_MIN_CHARS || trimmed.length > HEURISTIC_MAX_CHARS) return false;

  // Isolation: previous line must be blank or BOF. A heading sits in
  // its own paragraph — adjacent prose above means this is just a line
  // of regular text.
  if (lineAbove !== null && lineAbove.trim().length > 0) return false;

  // Section body: next line must be non-blank prose of meaningful
  // length. A short line below (or blank) suggests this isn't a
  // section break.
  if (lineBelow === null) return false;
  const belowTrimmed = lineBelow.trim();
  if (belowTrimmed.length < HEURISTIC_NEXT_LINE_MIN_CHARS) return false;

  // Cannot end in sentence-terminating punctuation.
  const lastChar = trimmed[trimmed.length - 1];
  if (SENTENCE_END_CHARS.has(lastChar)) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > HEURISTIC_MAX_WORDS) return false;

  // All-caps shortcut: "WANNACRY" / "UVB-76" / "BERMUDA TRIANGLE"
  // (any alphabetic, no lowercase letters).
  if (/[A-Z]/.test(trimmed) && !/[a-z]/.test(trimmed)) return true;

  // Title-case test: count words that start with an uppercase ASCII
  // letter, ignoring stopwords that are conventionally lowercase
  // ("the", "of", etc.) and the first word (which is always
  // capitalized in a title regardless of the word).
  let capCount = 0;
  let evaluated = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // Strip leading non-letter chars (quotes, em-dashes, etc.) to look
    // at the first alphabetic character.
    const firstAlpha = w.match(/[A-Za-z]/)?.[0];
    if (!firstAlpha) continue;
    const lowerWord = w.toLowerCase().replace(/[^a-z]/g, '');
    if (i > 0 && TITLE_CASE_STOPWORDS.has(lowerWord)) continue;
    evaluated++;
    if (firstAlpha === firstAlpha.toUpperCase()) capCount++;
  }
  if (evaluated === 0) return false;
  return capCount / evaluated >= 0.5;
}

/** If a user pastes content that already contains `<<TITLE_N>>` text, we
 *  scrub it so it can't collide with our own sentinels. The replacement
 *  preserves the visible text by escaping the angle brackets. */
const PREEXISTING_SENTINEL_RE = /<<TITLE_(\d+)>>/g;

export function extractScriptTitles(script: string): ExtractedScript {
  const warnings: string[] = [];

  // Scrub any pre-existing sentinel-shaped substrings from the input so the
  // LLM can't get confused about which sentinels are ours.
  const scrubbed = script.replace(PREEXISTING_SENTINEL_RE, '⟪TITLE_$1⟫');
  if (scrubbed !== script) {
    warnings.push('Stripped pre-existing <<TITLE_N>> markers from script input.');
  }

  const lines = scrubbed.split(/\r?\n/);
  const titles: ExtractedTitle[] = [];
  const outLines: string[] = [];
  let inFencedCode = false;
  let heuristicHits = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      inFencedCode = !inFencedCode;
      outLines.push(line);
      continue;
    }
    if (inFencedCode) {
      outLines.push(line);
      continue;
    }

    // 1) Explicit `## Heading` markdown — deterministic, preferred path.
    const m = HEADING_RE.exec(line);
    if (m && m[1].trim().length > 0) {
      if (titles.length >= MAX_TITLES) {
        warnings.push(
          `Script has more than ${MAX_TITLES} headings — extras left as plain text.`,
        );
        outLines.push(line);
        continue;
      }

      let text = m[1];
      if (text.length > MAX_TITLE_CHARS) {
        warnings.push(
          `Heading truncated to ${MAX_TITLE_CHARS} chars: "${text.slice(0, 40)}…"`,
        );
        text = text.slice(0, MAX_TITLE_CHARS);
      }

      const sentinel = `<<TITLE_${titles.length}>>`;
      titles.push({ text, sentinel });
      outLines.push(sentinel);
      continue;
    }

    // 2) Heuristic plain-text heading detection. Only fires when the
    //    explicit pattern didn't match. Looks at the line in context
    //    (line above must be blank/BOF, line below must be real prose)
    //    so a one-line aside in the middle of a paragraph won't get
    //    promoted to a title. See looksLikePlainTextHeading() for the
    //    detailed rules.
    const lineAbove = i > 0 ? lines[i - 1] : null;
    const lineBelow = i + 1 < lines.length ? lines[i + 1] : null;
    if (looksLikePlainTextHeading(line, lineAbove, lineBelow)) {
      if (titles.length >= MAX_TITLES) {
        warnings.push(
          `Script has more than ${MAX_TITLES} headings — extras left as plain text.`,
        );
        outLines.push(line);
        continue;
      }
      const trimmedText = line.trim();
      const text = trimmedText.length > MAX_TITLE_CHARS
        ? trimmedText.slice(0, MAX_TITLE_CHARS)
        : trimmedText;
      const sentinel = `<<TITLE_${titles.length}>>`;
      titles.push({ text, sentinel });
      outLines.push(sentinel);
      heuristicHits++;
      continue;
    }

    outLines.push(line);
  }

  if (heuristicHits > 0) {
    warnings.push(
      `Detected ${heuristicHits} plain-text heading${heuristicHits === 1 ? '' : 's'} ` +
      `via heuristic (no \`##\` prefix). Add \`## \` to each section title for deterministic extraction.`,
    );
  }

  return {
    stripped: outLines.join('\n'),
    titles,
    warnings,
  };
}

/** Regex used by the post-validator to detect sentinel leakage in LLM output. */
export const TITLE_SENTINEL_LEAK_RE = /<<TITLE_\d+>>/;
