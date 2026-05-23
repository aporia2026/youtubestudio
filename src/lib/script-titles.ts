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

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFencedCode = !inFencedCode;
      outLines.push(line);
      continue;
    }
    if (inFencedCode) {
      outLines.push(line);
      continue;
    }

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

    outLines.push(line);
  }

  return {
    stripped: outLines.join('\n'),
    titles,
    warnings,
  };
}

/** Regex used by the post-validator to detect sentinel leakage in LLM output. */
export const TITLE_SENTINEL_LEAK_RE = /<<TITLE_\d+>>/;
