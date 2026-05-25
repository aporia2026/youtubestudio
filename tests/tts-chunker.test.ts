import { describe, expect, it } from 'vitest';
import { chunkScriptForGoogle, DEFAULT_MAX_CHUNK_BYTES } from '@/lib/tts/chunker';

// Pinning the long-form chunker's behavior. Google's sync TTS endpoint
// enforces a 5,000-BYTE input limit (not characters) — Hebrew/Arabic
// multi-byte UTF-8 makes the byte-vs-char distinction load-bearing.

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('chunkScriptForGoogle — short inputs pass through', () => {
  it('returns empty array for empty input', () => {
    expect(chunkScriptForGoogle('')).toEqual([]);
    expect(chunkScriptForGoogle('   \n  ')).toEqual([]);
  });

  it('returns a single chunk when input fits in the limit', () => {
    const text = 'Hello world. This is a short script.';
    expect(chunkScriptForGoogle(text)).toEqual([text]);
  });
});

describe('chunkScriptForGoogle — sentence-boundary splits', () => {
  it('splits at sentence boundaries when input exceeds the limit', () => {
    // Build a script that's clearly over the limit by repeating a sentence.
    const sentence = 'This is a reasonable-length sentence about something interesting. ';
    const longText = sentence.repeat(100); // ~6,600 chars, ~6,600 bytes
    const chunks = chunkScriptForGoogle(longText, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(1500);
    }
    // Joined chunks should preserve the meaningful content (allowing
    // for whitespace normalization at boundaries).
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const expected = longText.replace(/\s+/g, ' ').trim();
    expect(rejoined).toBe(expected);
  });

  it('handles all three sentence terminators (. ! ?)', () => {
    const text = 'First sentence. Second sentence! Third sentence? Fourth sentence.';
    const chunks = chunkScriptForGoogle(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be a clean sentence (no orphan punctuation).
    for (const c of chunks) {
      expect(c.startsWith('.')).toBe(false);
      expect(c.startsWith('!')).toBe(false);
      expect(c.startsWith('?')).toBe(false);
    }
  });
});

describe('chunkScriptForGoogle — Hebrew (multi-byte UTF-8)', () => {
  it('respects byte limit not char limit on Hebrew content', () => {
    // Hebrew sentence — each char is 2 bytes in UTF-8.
    const hebrewSentence = 'שלום עולם זה משפט לדוגמה. ';
    expect(bytes(hebrewSentence)).toBeGreaterThan(hebrewSentence.length);
    const longHebrew = hebrewSentence.repeat(100);
    const chunks = chunkScriptForGoogle(longHebrew, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(1000);
    }
  });

  it('never splits a multi-byte UTF-8 codepoint across chunks', () => {
    // Pathological: a single "word" of Hebrew chars longer than the limit.
    // Hard-byte-split should still respect codepoint boundaries.
    const oneLongHebrewWord = 'אבגדהוזחטיכלמנסעפצקרשת'.repeat(200); // no spaces
    const chunks = chunkScriptForGoogle(oneLongHebrewWord, 100);
    for (const c of chunks) {
      // Round-trip through Buffer should preserve every codepoint
      // (no � replacement chars from broken UTF-8 sequences).
      const roundTripped = Buffer.from(c, 'utf8').toString('utf8');
      expect(roundTripped).toBe(c);
      expect(c).not.toContain('�');
      expect(bytes(c)).toBeLessThanOrEqual(100);
    }
  });
});

describe('chunkScriptForGoogle — pathological inputs', () => {
  it('falls back to comma split when one sentence exceeds the limit', () => {
    // Single sentence with commas, no other terminators.
    const longCommaSentence =
      'This is a very long sentence, with many commas, used to test fallback splitting, ' +
      'because there is no period to break on, so the chunker must split on commas instead, ' +
      'and keep each piece under the byte limit even when the source sentence is huge.';
    const chunks = chunkScriptForGoogle(longCommaSentence, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(80);
    }
  });

  it('falls back to word split when neither sentences nor commas help', () => {
    const longRun = 'word '.repeat(500).trim(); // no punctuation at all
    const chunks = chunkScriptForGoogle(longRun, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(100);
    }
  });

  it('hard-splits a single oversized token (URL/hash) as last resort', () => {
    // Single "word" longer than the limit — common with URLs.
    const oversize = 'a'.repeat(500);
    const chunks = chunkScriptForGoogle(oversize, 100);
    expect(chunks.length).toBe(5);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(100);
      expect(c).toBe('a'.repeat(c.length));
    }
  });
});

describe('chunkScriptForGoogle — realistic narration sizes', () => {
  it('a typical 22,000-char English script (~30 min YouTube) yields a small chunk count', () => {
    // ~150 chars per sentence × 150 sentences = ~22,000 chars.
    const sentence =
      'This is a representative sentence in a YouTube narration that explains a concept ' +
      'with reasonable density and a comfortable pace for the listener. ';
    const script = sentence.repeat(150);
    const chunks = chunkScriptForGoogle(script);
    // Should chunk cleanly — typical narrations should fit in ~6 chunks
    // at the default 4,500-byte limit (22 KB / 4.5 KB ≈ 5).
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.length).toBeLessThan(15);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_BYTES);
    }
  });
});
