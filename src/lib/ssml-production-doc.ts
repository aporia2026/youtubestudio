/**
 * SSML preprocessor for the production-doc generator.
 *
 * Users sometimes paste an SSML script into the production-doc form:
 *
 *     <speak>
 *     Hessdalen Lights.<break time="1s"/>
 *     Hessdalen Valley, Norway. Lights consistently appear...
 *
 *     <break time="2s"/>
 *
 *     The Phoenix Lights.<break time="1s"/>
 *     ...
 *     </speak>
 *
 * Without preprocessing the LLM saw all those `<break>` tags as literal
 * text, polluted the output rows with tag fragments, and had to guess
 * section boundaries from punctuation alone. The user authored explicit
 * structural hints in the SSML — we should honor them.
 *
 * This module:
 *   1. Detects SSML-shaped input (same heuristic as the TTS chunker)
 *   2. Splits the inner content on `<break time>=...` boundaries with
 *      duration ≥ `sectionBreakSeconds` (default 1.5s — captures
 *      `time="2s"` and above, which is the typical section separator)
 *   3. Strips every SSML tag from each section so the LLM sees only
 *      narration text
 *   4. Returns clean plain-text script + ordered list of section
 *      strings the prompt can pass through as authoritative row hints
 *
 * Pure functions. The route handlers and auto-pipeline stage both
 * call `preprocessSsmlForProductionDoc` at the top of their flow.
 */

const TAG_STRIP_REGEX = /<[^>]+>/g;

export interface SsmlPreprocessResult {
  /** True when the original input was SSML-shaped. False for plain text. */
  wasSsml: boolean;
  /** Plain-text script with every SSML tag stripped. This is what the
   *  LLM prompt receives. Always non-empty when wasSsml=true. */
  cleanScript: string;
  /** Section bodies in document order. Each entry is a span of script
   *  text that fell between two long `<break>` tags (or between a
   *  break and the document boundary). Empty array when wasSsml=false
   *  or when the SSML had no section-level breaks. */
  sections: string[];
}

/**
 * Heuristic SSML detector. Matches text starting with `<speak>`
 * (allowing leading whitespace + attributes) or containing `<break ...>`
 * tags. Conservative — won't flag plain text with stray angle brackets.
 */
export function isSsml(text: string): boolean {
  const trimmed = text.trimStart();
  if (/^<speak\b/i.test(trimmed)) return true;
  if (/<break\s/i.test(text)) return true;
  return false;
}

/**
 * Parse `time="2s"` / `time="500ms"` from a `<break>` tag string.
 * Returns 0.5 (Google's documented default) when no time attribute
 * is present.
 */
function breakSeconds(tag: string): number {
  const m = tag.match(/time\s*=\s*["'](\d+(?:\.\d+)?)\s*(ms|s)?["']/i);
  if (!m) return 0.5;
  const value = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return unit === 'ms' ? value / 1000 : value;
}

function stripSpeakWrapper(ssml: string): string {
  const opening = ssml.match(/^\s*<speak\b[^>]*>/i);
  const closing = ssml.match(/<\/speak>\s*$/i);
  if (opening) {
    const start = opening[0].length;
    const end = closing ? ssml.length - closing[0].length : ssml.length;
    return ssml.slice(start, end);
  }
  return ssml;
}

/** Strip every XML/SSML tag and collapse repeated whitespace. */
function tagsToText(ssml: string): string {
  return ssml
    .replace(TAG_STRIP_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract section bodies from inner SSML. A section boundary is any
 * `<break>` whose duration is ≥ `minBreakSeconds`. Shorter breaks
 * (intra-sentence pauses, `<break time="500ms"/>`) stay inside their
 * section and contribute nothing structural.
 */
function extractSections(innerSsml: string, minBreakSeconds: number): string[] {
  const sections: string[] = [];
  const breakRegex = /<break\b[^>]*?\/?>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = breakRegex.exec(innerSsml)) !== null) {
    const seconds = breakSeconds(match[0]);
    if (seconds < minBreakSeconds) continue;          // intra-section pause, ignore
    const chunk = innerSsml.slice(lastIndex, match.index);
    const text = tagsToText(chunk);
    if (text) sections.push(text);
    lastIndex = match.index + match[0].length;
  }

  const tail = tagsToText(innerSsml.slice(lastIndex));
  if (tail) sections.push(tail);
  return sections;
}

/**
 * Top-level: route input through the SSML preprocessor. Plain-text
 * scripts pass through unchanged with wasSsml=false; SSML scripts
 * return both the cleaned plain-text body and the ordered section
 * list the prompt should treat as authoritative row boundaries.
 */
export function preprocessSsmlForProductionDoc(
  script: string,
  options: { sectionBreakSeconds?: number } = {},
): SsmlPreprocessResult {
  if (!isSsml(script)) {
    return { wasSsml: false, cleanScript: script, sections: [] };
  }
  const inner = stripSpeakWrapper(script);
  const minBreakSeconds = options.sectionBreakSeconds ?? 1.5;
  const sections = extractSections(inner, minBreakSeconds);
  // Build the cleaned script as the sections joined by paragraph
  // breaks. Reproduces the user's authored structure as plain text
  // while preserving the visible separation between sections for any
  // downstream consumer that does its own paragraph parsing.
  const cleanScript = sections.length > 0 ? sections.join('\n\n') : tagsToText(inner);
  return { wasSsml: true, cleanScript, sections };
}
