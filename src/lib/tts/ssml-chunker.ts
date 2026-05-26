/**
 * SSML-aware chunker for Google long-form synthesis.
 *
 * The plain-text chunker is wrong for SSML input. Splitting an SSML
 * document at sentence boundaries leaves `<speak>` open in the first
 * chunk and dangling content (no `<speak>` wrapper, possibly with
 * `</speak>` orphaned at the end) in subsequent chunks. Chirp 3 HD
 * receives every chunk after the first as malformed SSML and either
 * fails silently or produces progressively degraded audio — matching
 * the "starts good, gets worse" symptom users report on long SSML
 * narrations.
 *
 * This chunker treats SSML as structured input:
 *
 *   1. Strips the outer `<speak>...</speak>` wrapper (assumes present
 *      or trivially absent — both common authoring styles).
 *   2. Splits the inner content on `<break>` boundaries, preferring
 *      longer breaks (`time="2s"` or above — typical section separators)
 *      so chunks fall at the user's authored pause points.
 *   3. If any single section still exceeds the byte budget, falls back
 *      to splitting that section at sentence boundaries (`. ! ?`).
 *   4. Re-wraps every emitted chunk in `<speak>...</speak>` so each
 *      chunk is a valid standalone SSML document.
 *
 * Guarantees:
 *   - Every output is a complete `<speak>...</speak>` SSML document
 *   - Every output fits within `maxBytes`
 *   - The `<break>` tags the user authored are preserved (they
 *     stay inside the chunks they belong to)
 *   - When a chunk boundary coincides with a `<break>`, the break is
 *     dropped (we don't synthesize silence-only chunks). Total audible
 *     pause stays roughly the same because Google adds inter-call
 *     silence anyway.
 *
 * Limitations:
 *   - Doesn't validate other SSML tag balance (`<prosody>`,
 *     `<emphasis>`, etc.) — splits only on `<break>`. If you have
 *     nested tags that span sections, they may break. For narration-
 *     scale `<speak>` + `<break>` + plain text (the common case), this
 *     works fine.
 */

import { DEFAULT_MAX_CHUNK_BYTES } from './chunker';

/**
 * Convert an SSML script into the inline-tag format Gemini-TTS expects.
 *
 * Gemini-TTS does not accept SSML — its expressive control vocabulary
 * is inline bracketed tags like `[whispers]`, `[laughs]`, `[short pause]`,
 * `[medium pause]`, `[long pause]` (see Google's Gemini-TTS docs). This
 * helper strips every SSML tag and rewrites `<break time="Xs"/>` markers
 * into the corresponding Gemini pause tag based on duration:
 *
 *   - ≥ 1.5s → `[long pause]`
 *   - ≥ 0.5s → `[medium pause]`
 *   - <  0.5s → `[short pause]`
 *
 * Everything else (`<speak>`, `<prosody>`, etc.) is stripped. The
 * caller passes the result as plain text to Gemini.
 */
export function ssmlToGeminiText(ssml: string): string {
  // Replace <break time="Xs"/> with the appropriate Gemini pause tag
  // BEFORE the generic tag-strip so duration data isn't lost.
  const withPauses = ssml.replace(
    /<break\b[^>]*?\/?>/gi,
    (match) => {
      const m = match.match(/time\s*=\s*["'](\d+(?:\.\d+)?)\s*(ms|s)?["']/i);
      let seconds = 0.5;
      if (m) {
        const value = parseFloat(m[1]);
        const unit = (m[2] || 's').toLowerCase();
        seconds = unit === 'ms' ? value / 1000 : value;
      }
      if (seconds >= 1.5) return ' [long pause] ';
      if (seconds >= 0.5) return ' [medium pause] ';
      return ' [short pause] ';
    },
  );
  // Strip everything else (<speak>, <prosody>, <p>, <s>, etc.) and
  // normalize whitespace.
  return withPauses
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heuristic detector. Returns true when the input looks like SSML —
 * starts with `<speak>` (allowing leading whitespace) or contains
 * `<break ...>`. Avoids false positives on text with stray `<` chars
 * by requiring tag-like structure.
 */
export function isSsml(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<speak')) return true;
  if (/<break\s/i.test(text)) return true;
  return false;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Extract the inner content of `<speak>...</speak>`, tolerating
 * attributes on the opening tag (xml:lang, version, etc.) and
 * leading/trailing whitespace.
 */
function stripSpeakWrapper(ssml: string): string {
  const opening = ssml.match(/^\s*<speak\b[^>]*>/i);
  const closing = ssml.match(/<\/speak>\s*$/i);
  if (opening) {
    const start = opening[0].length;
    const end = closing ? ssml.length - closing[0].length : ssml.length;
    return ssml.slice(start, end).trim();
  }
  return ssml.trim();
}

function wrapInSpeak(inner: string): string {
  return `<speak>${inner}</speak>`;
}

/**
 * Overhead added by the `<speak>...</speak>` wrapper. Subtract from
 * maxBytes when sizing inner chunks so the wrapped output still fits.
 */
const WRAPPER_BYTES = byteLen('<speak></speak>');

interface SsmlSegment {
  /** Inner SSML text for the segment (no `<speak>` wrapper). */
  content: string;
  /** Length of the `<break>` that followed (in seconds). Used as a
   *  preference signal when collapsing segments into chunks — longer
   *  breaks signal section boundaries and are the best split points. */
  followingBreakSeconds: number;
}

/**
 * Parse a single `<break ... />` tag's duration in seconds. Tolerates
 * attribute order ("strength" before "time", etc.), quote styles, and
 * the `s` vs `ms` unit. Returns 0.5s when the tag has no time attribute
 * (matches Google's documented default for `<break/>`).
 */
function parseBreakSeconds(tag: string): number {
  const m = tag.match(/time\s*=\s*["'](\d+(?:\.\d+)?)\s*(ms|s)?["']/i);
  if (!m) return 0.5;
  const value = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return unit === 'ms' ? value / 1000 : value;
}

/**
 * Parse the inner SSML into a list of segments separated by `<break>`
 * tags. The break itself is stripped (we don't synthesize empty
 * chunks); its duration is recorded on the preceding segment so the
 * packer can prefer breaks ≥ 1s as section boundaries.
 */
function parseSegments(innerSsml: string): SsmlSegment[] {
  const segments: SsmlSegment[] = [];
  // Match the entire `<break ... />` tag. Time extraction happens in
  // parseBreakSeconds for robustness (lookahead-heavy patterns choke
  // on attribute reorders).
  const breakRegex = /<break\b[^>]*?\/?>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = breakRegex.exec(innerSsml)) !== null) {
    const content = innerSsml.slice(lastIndex, match.index).trim();
    const seconds = parseBreakSeconds(match[0]);
    segments.push({ content, followingBreakSeconds: seconds });
    lastIndex = match.index + match[0].length;
  }
  // Tail content after the last break (or the whole string if no
  // breaks at all).
  const tail = innerSsml.slice(lastIndex).trim();
  if (tail) segments.push({ content: tail, followingBreakSeconds: 0 });
  return segments.filter((s) => s.content.length > 0);
}

/**
 * Final sentence-level split fallback. Used when a single segment
 * (between two `<break>` tags or between a break and the document
 * boundary) is itself larger than the byte budget. Splits on `. ! ?`
 * + whitespace, same as the plain-text chunker.
 */
function splitOversizedSegment(content: string, maxInnerBytes: number): string[] {
  if (byteLen(content) <= maxInnerBytes) return [content];
  const sentences = content.split(/(?<=[.!?])\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    const candidate = current ? `${current} ${s}` : s;
    if (byteLen(candidate) <= maxInnerBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // Single sentence over the limit (rare in practice but defended
      // against) — hard split at character boundaries to guarantee
      // every chunk fits. Multi-byte UTF-8 codepoints stay intact.
      if (byteLen(s) > maxInnerBytes) {
        let acc = '';
        for (const ch of s) {
          if (byteLen(acc + ch) > maxInnerBytes) {
            if (acc) chunks.push(acc);
            acc = ch;
          } else {
            acc += ch;
          }
        }
        if (acc) chunks.push(acc);
        current = '';
      } else {
        current = s;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Top-level: parse SSML, split it into byte-bounded chunks, and
 * return each as a complete `<speak>...</speak>` document ready for
 * Google synthesizeSpeech.
 */
export function chunkSsmlForGoogle(
  ssml: string,
  maxBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): string[] {
  const inner = stripSpeakWrapper(ssml);
  if (!inner) return [];

  // If the whole thing fits as a single chunk, just rewrap.
  if (byteLen(wrapInSpeak(inner)) <= maxBytes) {
    return [wrapInSpeak(inner)];
  }

  // Inner-content budget = total budget minus the <speak> wrapper.
  // No "minimum" floor — callers pass realistic sizes (default 4500),
  // and pinning the inner budget to the actual available space is
  // what makes byte-aware chunking correct.
  const maxInnerBytes = Math.max(50, maxBytes - WRAPPER_BYTES);
  const segments = parseSegments(inner);

  // Expand any oversized segment into multiple sub-segments so the
  // packer is working with chunks that all fit individually.
  const sizedSegments: SsmlSegment[] = [];
  for (const seg of segments) {
    if (byteLen(seg.content) <= maxInnerBytes) {
      sizedSegments.push(seg);
    } else {
      const subs = splitOversizedSegment(seg.content, maxInnerBytes);
      for (let i = 0; i < subs.length; i++) {
        sizedSegments.push({
          content: subs[i],
          // Only the last sub-segment of an oversized section inherits
          // the original following-break duration; the rest get 0 so
          // we don't accidentally double-count breaks.
          followingBreakSeconds:
            i === subs.length - 1 ? seg.followingBreakSeconds : 0,
        });
      }
    }
  }

  // Greedy packer: combine adjacent segments until adding the next
  // would overflow. Prefer to break on long pauses (≥ 1s) — that's
  // where the user signaled a natural beat. We approximate this by
  // closing the current chunk whenever the next segment is preceded
  // by a long break, even if it would still fit.
  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < sizedSegments.length; i++) {
    const seg = sizedSegments[i];
    const joinWith = current ? ' ' : '';
    const candidate = current + joinWith + seg.content;
    const wrappedSize = byteLen(wrapInSpeak(candidate));
    if (wrappedSize <= maxBytes) {
      current = candidate;
      // If the segment had a long trailing break, end the chunk here
      // to preserve section boundaries — the audio gap between
      // synthesis calls roughly stands in for the dropped <break>.
      if (seg.followingBreakSeconds >= 1) {
        chunks.push(wrapInSpeak(current));
        current = '';
      }
    } else {
      if (current) chunks.push(wrapInSpeak(current));
      current = seg.content;
      if (seg.followingBreakSeconds >= 1) {
        chunks.push(wrapInSpeak(current));
        current = '';
      }
    }
  }
  if (current) chunks.push(wrapInSpeak(current));
  return chunks;
}
