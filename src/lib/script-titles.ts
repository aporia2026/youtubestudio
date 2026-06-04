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
  /** The script line as it appeared BEFORE sentinel replacement. Used by the
   *  pre-flight title-review feature: when a user deletes a detected title in
   *  the UI, the route restores this exact text into `stripped` so the LLM
   *  sees the section as plain prose rather than a title boundary. */
  originalLine: string;
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
 *   - NOT wholly wrapped in `[...]` (rejects production cues like
 *     `[SFX: ...]` and `[VISUAL CUE: ...]`)
 *   - blank line above (or beginning of file)
 *   - 3-60 characters
 *   - 1-10 words
 *   - no sentence-terminating punctuation at the end, EXCEPT a single
 *     trailing `.` is allowed for short (≤4-word) lines where every
 *     non-stopword word is capitalized — the YouTube title-card
 *     pattern ("Knight Capital.", "Ariane 5.")
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

/** Title-card-with-period exception: a line ending in a single `.` is allowed
 *  if it is at most this many words. Catches the YouTube-style title-card
 *  pattern ("Knight Capital.", "Mars Climate Orbiter.", "Ariane 5.") without
 *  swallowing real prose sentences ("Cargo mostly intact.", which fails the
 *  title-case ratio anyway, but this gives us a tight extra guard). */
const TITLE_CARD_PERIOD_MAX_WORDS = 4;

/** Detects a line that is wholly wrapped in square brackets, like
 *  `[SFX: ...]` or `[VISUAL CUE: ...]`. These are production cues, not
 *  section titles, and must never be promoted to Title Cards. */
const BRACKET_WRAPPED_RE = /^\[.*\]$/;

/** When the immediate line below a candidate heading is blank, look at
 *  most this many lines further down for the section body. Catches the
 *  common `Title.\n\nBody paragraph...` shape without scanning the
 *  whole script for a distant non-blank line. */
const LINE_BELOW_LOOKAHEAD = 3;

export function looksLikePlainTextHeading(
  current: string,
  lineAbove: string | null,
  lineBelow: string | null,
): boolean {
  const trimmed = current.trim();
  if (trimmed.length < HEURISTIC_MIN_CHARS || trimmed.length > HEURISTIC_MAX_CHARS) return false;

  // Production cues like `[SFX: ...]` or `[VISUAL CUE: ...]` look
  // title-shaped (short, no terminator, lots of capitals) but are not
  // titles. Reject deterministically before any other test.
  if (BRACKET_WRAPPED_RE.test(trimmed)) return false;

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

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > HEURISTIC_MAX_WORDS) return false;

  // Terminator rule: lines ending in `, ; : ! ?` or in `..`/`...` are
  // never headings. A single trailing `.` is allowed ONLY for the
  // title-card-with-period exception below — short noun-phrase titles
  // like "Knight Capital." that creators conventionally punctuate.
  const lastChar = trimmed[trimmed.length - 1];
  const endsWithSinglePeriod =
    lastChar === '.' && trimmed[trimmed.length - 2] !== '.';
  const endsWithOtherSentenceChar =
    SENTENCE_END_CHARS.has(lastChar) && lastChar !== '.';
  const endsWithMultiPeriod = lastChar === '.' && !endsWithSinglePeriod;
  if (endsWithOtherSentenceChar || endsWithMultiPeriod) return false;
  if (endsWithSinglePeriod && words.length > TITLE_CARD_PERIOD_MAX_WORDS) {
    return false;
  }

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
  // Single-period title cards demand stricter title-case: every
  // evaluated word must be capitalized. Without this, the period
  // exception would let "Cargo mostly intact." through if the ratio
  // ever wobbled.
  if (endsWithSinglePeriod) return capCount === evaluated;
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
      titles.push({ text, sentinel, originalLine: line });
      outLines.push(sentinel);
      continue;
    }

    // 2) Heuristic plain-text heading detection. Only fires when the
    //    explicit pattern didn't match. Looks at the line in context
    //    (line above must be blank/BOF, line below must be real prose)
    //    so a one-line aside in the middle of a paragraph won't get
    //    promoted to a title. See looksLikePlainTextHeading() for the
    //    detailed rules.
    //
    //    `lineBelow` is the next NON-BLANK line within a short
    //    lookahead window — a heading is often followed by a blank
    //    paragraph break before the body ("Knight Capital.\n\nAugust
    //    1st, 2012..."). Without the lookahead we miss every such
    //    title.
    const lineAbove = i > 0 ? lines[i - 1] : null;
    let lineBelow: string | null = null;
    for (let j = i + 1; j < Math.min(i + 1 + LINE_BELOW_LOOKAHEAD, lines.length); j++) {
      if (lines[j].trim().length > 0) {
        lineBelow = lines[j];
        break;
      }
    }
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
      titles.push({ text, sentinel, originalLine: line });
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

// ---------------------------------------------------------------------------
// Pre-flight user-title overrides
//
// The production-doc page renders a TitleReviewPanel that lets the user
// EDIT detected title text, DELETE detected titles (false positives), and
// ADD titles the heuristic missed. The page submits the final list as
// `userTitles` in the generation request; the route calls
// `applyUserTitleOverrides` to rebuild the `{stripped, titles}` pair the
// prompt + post-validator consume.
//
// See `_plans/2026-05-31-preflight-title-review.md`.
// ---------------------------------------------------------------------------

export interface UserTitleSpec {
  /** Final title text (after the user's edits). Required and non-empty. */
  text: string;
  /** Present iff this title corresponds to a detected one. The route uses
   *  it to look up the matching `ExtractedTitle` for position + original
   *  line. Absent ⇒ this is a user-added title. */
  sourceSentinel?: string;
  /** For ADDED titles only: the sentinel to insert AFTER. Use `null` to
   *  insert at the start of the script. Ignored when `sourceSentinel` is
   *  set. */
  insertAfterSentinel?: string | null;
  /** Marks a detected title for removal — its sentinel in the stripped
   *  script is replaced with its `originalLine` and the title is dropped
   *  from the prompt's title list. */
  deleted?: boolean;
}

export interface AppliedTitleOverrides {
  /** Rebuilt stripped script with sentinel edits, deletions, and
   *  insertions applied. */
  stripped: string;
  /** Final ordered title list (matches the order in `stripped`). */
  titles: ExtractedTitle[];
  /** Diagnostics surfaced to the user as generation_warnings. */
  warnings: string[];
  /** Counts for the [production-doc title-overrides] log line. */
  counts: { edited: number; deleted: number; added: number };
}

/** Sentinel string for a user-added title at zero-based index `i`. */
function userTitleSentinel(i: number): string {
  return `<<TITLE_USER_${i}>>`;
}

/**
 * Rebuild the stripped script + title list from a baseline `extracted`
 * result and a user-edited title list. The returned `{stripped, titles}`
 * is what the prompt builder + post-LLM allowlist should use.
 *
 * Algorithm:
 *   1. Iterate the user's ordered title list. For each entry:
 *      - `sourceSentinel` set, NOT `deleted`: kept-as-is detected title.
 *        Carry forward, override text.
 *      - `sourceSentinel` set, `deleted`: drop. We remember the sentinel
 *        so step 3 can restore the original line in `stripped`.
 *      - `sourceSentinel` absent: added title. Park it under the
 *        `insertAfterSentinel` bucket; null bucket = "at start".
 *   2. Assign new sentinels: walk in script order using the baseline
 *      `extracted.stripped` so kept detected sentinels keep their place
 *      and added ones land where the user wanted.
 *   3. Apply edits to `stripped`: replace deleted sentinels with their
 *      original lines, and inject added sentinels after the indicated
 *      sentinel (or at the start).
 *
 * Unknown `sourceSentinel` / `insertAfterSentinel` values become warnings
 * rather than errors — the front-end may legitimately fall slightly out
 * of sync with the latest detection, and we'd rather degrade gracefully.
 */
export function applyUserTitleOverrides(
  extracted: ExtractedScript,
  userTitles: readonly UserTitleSpec[],
): AppliedTitleOverrides {
  const warnings: string[] = [];
  let edited = 0;
  let deleted = 0;
  let added = 0;

  const detectedBySentinel = new Map<string, ExtractedTitle>();
  for (const t of extracted.titles) detectedBySentinel.set(t.sentinel, t);

  // Group ADDED titles by which existing sentinel they insert after.
  // `null` ⇒ at start. Unknown `insertAfterSentinel` (sentinel that no
  // longer exists) ⇒ at end — this is the graceful-degrade path when
  // the front-end is slightly out of sync with the latest detection.
  const additionsAtStart: { text: string; userIndex: number }[] = [];
  const additionsAfter = new Map<string, { text: string; userIndex: number }[]>();
  const additionsAtEnd: { text: string; userIndex: number }[] = [];

  // Which detected sentinels survived (kept or edited).
  const keptDetected = new Map<string, ExtractedTitle>();
  // Order in which user surfaces the kept-detected titles. Used only for
  // the final `titles` array ordering — `stripped` ordering is driven by
  // the baseline script positions.
  const keptOrder: string[] = [];

  let addedIndex = 0;
  for (const spec of userTitles) {
    const text = (spec.text ?? '').trim();
    if (!text) {
      warnings.push('A title with empty text was skipped.');
      continue;
    }
    if (spec.sourceSentinel) {
      const detected = detectedBySentinel.get(spec.sourceSentinel);
      if (!detected) {
        warnings.push(
          `Ignoring an edit to "${text}" — its source title is no longer in the script. Re-detect titles if the script was changed.`,
        );
        continue;
      }
      if (spec.deleted) {
        deleted += 1;
        continue;
      }
      const updated: ExtractedTitle = {
        ...detected,
        text,
      };
      if (updated.text !== detected.text) edited += 1;
      keptDetected.set(spec.sourceSentinel, updated);
      keptOrder.push(spec.sourceSentinel);
    } else {
      const at = spec.insertAfterSentinel ?? null;
      added += 1;
      const entry = { text, userIndex: addedIndex++ };
      if (at === null) {
        additionsAtStart.push(entry);
      } else if (detectedBySentinel.has(at)) {
        const bucket = additionsAfter.get(at) ?? [];
        bucket.push(entry);
        additionsAfter.set(at, bucket);
      } else {
        warnings.push(
          `Added title "${text}" pointed at a sentinel that no longer exists — inserted at the end instead.`,
        );
        additionsAtEnd.push(entry);
      }
    }
  }

  // Build a list of operations against `stripped`. Each detected sentinel
  // line in the stripped script is either kept, deleted (replaced with
  // its originalLine), and may have one-or-more added sentinels injected
  // after it. Plus a leading bucket for "at start" additions.
  const lines = extracted.stripped.split(/\r?\n/);
  const finalLines: string[] = [];
  const finalTitles: ExtractedTitle[] = [];

  // Emit any "at start" additions first.
  for (const a of additionsAtStart) {
    const sentinel = userTitleSentinel(a.userIndex);
    finalLines.push(sentinel);
    finalTitles.push({ text: a.text, sentinel, originalLine: sentinel });
  }

  for (const line of lines) {
    const sentinelMatch = line.match(/^<<TITLE_\d+>>$/);
    if (!sentinelMatch) {
      finalLines.push(line);
      continue;
    }
    const sentinel = sentinelMatch[0];
    const detected = detectedBySentinel.get(sentinel);
    if (!detected) {
      // Sentinel shape but not in the detected map — leave as-is. Shouldn't
      // happen in normal flow but guards against script tampering.
      finalLines.push(line);
      continue;
    }
    const kept = keptDetected.get(sentinel);
    if (kept) {
      finalLines.push(sentinel);
      finalTitles.push(kept);
    } else {
      // Detected but the user did NOT include it in `userTitles` — treat
      // as a delete. Two paths land here: explicit `deleted: true` (already
      // counted above) and silent omission. Both restore the original line.
      finalLines.push(detected.originalLine);
      // Only count silent omissions here so we don't double-count.
      // `deleted` already incremented when `deleted: true` was set.
      // userTitles silently omitting a detected sentinel: count it.
      const userHadIt = userTitles.some(u => u.sourceSentinel === sentinel);
      if (!userHadIt) deleted += 1;
    }
    // Then any additions parked after this sentinel.
    const after = additionsAfter.get(sentinel);
    if (after) {
      for (const a of after) {
        const newSentinel = userTitleSentinel(a.userIndex);
        finalLines.push(newSentinel);
        finalTitles.push({ text: a.text, sentinel: newSentinel, originalLine: newSentinel });
      }
    }
  }

  // Trailing additions — graceful-degrade bucket for adds whose target
  // sentinel was no longer in the script (front-end out of sync).
  for (const a of additionsAtEnd) {
    const newSentinel = userTitleSentinel(a.userIndex);
    finalLines.push(newSentinel);
    finalTitles.push({ text: a.text, sentinel: newSentinel, originalLine: newSentinel });
  }

  return {
    stripped: finalLines.join('\n'),
    titles: finalTitles,
    warnings,
    counts: { edited, deleted, added },
  };
}
