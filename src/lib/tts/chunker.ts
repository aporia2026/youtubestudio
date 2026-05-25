/**
 * Long-form script chunker for the Google TTS sync endpoint.
 *
 * Google's `synthesizeSpeech` enforces a 5,000-BYTE input limit (not
 * character limit — important for Hebrew and other languages where
 * each glyph is multiple UTF-8 bytes). Anything larger comes back
 * with INVALID_ARGUMENT. For a 30-minute YouTube narration you can
 * easily exceed this — a 20,000-character English script is ~20 KB,
 * a 15,000-character Hebrew script is ~25 KB.
 *
 * Splitting strategy (descending preference):
 *
 *   1. Sentence boundaries — `. ! ?` followed by whitespace. Works for
 *      English, Hebrew, Spanish, French, German, Arabic — they all
 *      use the same terminal punctuation. The resulting joints fall
 *      at natural pauses where Google's TTS already inserts a brief
 *      silence, so byte-level MP3 concatenation produces no audible
 *      seam (verified across Chirp 3 HD voices).
 *
 *   2. Comma boundaries — when a single "sentence" is itself larger
 *      than the limit. Rare in well-written narration but happens with
 *      list-heavy paragraphs or LLM-generated text without periods.
 *
 *   3. Word boundaries — when even comma-segments exceed the limit.
 *      Audible at the joint but only triggers on pathological inputs.
 *
 *   4. Hard byte-level split — last resort for runaway tokens (URLs,
 *      hashed identifiers). Splits at character boundaries so a
 *      multi-byte UTF-8 codepoint never falls across two chunks.
 *
 * The chunker is intentionally NOT SSML-aware: callers that pass SSML
 * to the long-form path should reject up front (chunking would slice
 * across `<break>` / `<voice>` tags and produce broken markup). The
 * Google provider does that check.
 *
 * Pure function — easy to test, no network or filesystem access.
 */

/**
 * Conservative default. Google's documented limit is 5,000 bytes; we
 * leave a 500-byte safety margin to account for any server-side
 * normalization (typographic quote conversion, etc.) that could push
 * a chunk over the line after we've measured it.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 4500;

export function chunkScriptForGoogle(
  text: string,
  maxBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (byteLen(trimmed) <= maxBytes) return [trimmed];

  // Split on sentence terminators followed by whitespace. The
  // lookbehind keeps the terminator attached to the preceding
  // sentence so we don't get orphan "." in the next chunk.
  const sentences = trimmed.split(/(?<=[.!?])\s+/u).filter(Boolean);

  return packIntoChunks(sentences, maxBytes, splitOversizedSentence);
}

function splitOversizedSentence(sentence: string, maxBytes: number): string[] {
  // Try comma + whitespace boundaries.
  const commaPieces = sentence.split(/(?<=,)\s+/u).filter(Boolean);
  if (commaPieces.length > 1) {
    return packIntoChunks(commaPieces, maxBytes, splitOversizedWords);
  }
  // Single phrase with no commas — fall straight to word-level.
  return splitOversizedWords(sentence, maxBytes);
}

function splitOversizedWords(phrase: string, maxBytes: number): string[] {
  const words = phrase.split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return packIntoChunks(words, maxBytes, hardByteSplit);
  }
  // A single "word" exceeds the limit (URLs, long hashes, etc.).
  return hardByteSplit(phrase, maxBytes);
}

/**
 * Last-resort splitter: walks the string codepoint-by-codepoint so a
 * multi-byte UTF-8 sequence never lands across two chunks. Triggers
 * only on pathological inputs (a single token > maxBytes).
 */
function hardByteSplit(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const ch of text) {
    const candidate = current + ch;
    if (byteLen(candidate) <= maxBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = ch;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Greedy packer: walks the pieces and accumulates them into chunks
 * until adding the next piece would overflow `maxBytes`. When a single
 * piece is itself too large, delegates to `splitOverflow` for a
 * finer-grained split.
 */
function packIntoChunks(
  pieces: string[],
  maxBytes: number,
  splitOverflow: (piece: string, maxBytes: number) => string[],
): string[] {
  const chunks: string[] = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const piece of pieces) {
    if (byteLen(piece) > maxBytes) {
      // The piece itself overflows — flush current, then split the
      // oversized piece via the next-level splitter.
      push();
      for (const sub of splitOverflow(piece, maxBytes)) {
        chunks.push(sub);
      }
      continue;
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (byteLen(candidate) <= maxBytes) {
      current = candidate;
    } else {
      push();
      current = piece;
    }
  }
  push();
  return chunks;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
