import { describe, expect, it } from 'vitest';
import { chunkSsmlForGoogle, isSsml } from '@/lib/tts/ssml-chunker';

// Pins the SSML chunker behavior. The bug it guards against: plain-
// text chunking of SSML input cuts the <speak>...</speak> wrapper
// across chunk boundaries, leaving every chunk after the first as
// malformed SSML. Chirp 3 HD's response to malformed SSML is the
// "starts good, gets worse" audio symptom users reported on long
// narrations.

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function looksLikeValidSpeakBlock(chunk: string): boolean {
  // Every emitted chunk must be a complete <speak>...</speak>
  // document — opening tag at start, closing tag at end, content
  // in between.
  return /^<speak>/.test(chunk) && /<\/speak>$/.test(chunk);
}

describe('isSsml — heuristic detection', () => {
  it('detects <speak> as the opening tag', () => {
    expect(isSsml('<speak>Hello</speak>')).toBe(true);
    expect(isSsml('  <speak version="1.0">Hello</speak>')).toBe(true);
  });

  it('detects <break> tags even without a <speak> wrapper', () => {
    expect(isSsml('Hello <break time="1s"/> world')).toBe(true);
  });

  it('does not flag plain text with stray angle brackets', () => {
    expect(isSsml('A test of 5 > 3 < 4 reasoning')).toBe(false);
    expect(isSsml('No tags here at all')).toBe(false);
  });
});

describe('chunkSsmlForGoogle — single-chunk inputs', () => {
  it('returns one wrapped chunk when input already fits', () => {
    const input = '<speak>Hello world.</speak>';
    const chunks = chunkSsmlForGoogle(input);
    expect(chunks).toEqual(['<speak>Hello world.</speak>']);
  });

  it('preserves attributes on the outer <speak> by re-wrapping cleanly', () => {
    const input = '<speak version="1.0">Hello.</speak>';
    const chunks = chunkSsmlForGoogle(input);
    // Output is normalized — attributes drop because we re-wrap, but
    // the inner content survives.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Hello.');
    expect(looksLikeValidSpeakBlock(chunks[0])).toBe(true);
  });
});

describe('chunkSsmlForGoogle — section-boundary splits', () => {
  it('splits on <break time="2s"/> boundaries (typical section separator)', () => {
    const sections = [
      'First section content.',
      'Second section content.',
      'Third section content.',
    ];
    const input = `<speak>${sections.join(' <break time="2s"/> ')}</speak>`;
    // Tiny byte limit forces multiple chunks. Each section is ~25
    // bytes, so a 50-byte limit forces one section per chunk.
    const chunks = chunkSsmlForGoogle(input, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(looksLikeValidSpeakBlock(c)).toBe(true);
      expect(bytes(c)).toBeLessThanOrEqual(50);
    }
    // Sections survive across the chunks somewhere.
    const rejoined = chunks.map((c) => c.replace(/<\/?speak>/g, '')).join(' ');
    for (const s of sections) {
      expect(rejoined).toContain(s);
    }
  });

  it('also splits on <break time="1s"/> when ≥ 1s — preserves user-authored beats', () => {
    const input = '<speak>Part one. <break time="1s"/> Part two.</speak>';
    const chunks = chunkSsmlForGoogle(input, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(looksLikeValidSpeakBlock(c)).toBe(true);
  });

  it('does not split on sub-second breaks (they stay inside their chunk)', () => {
    const input =
      '<speak>Sentence one with subtle pause <break time="500ms"/> and continuation.</speak>';
    const chunks = chunkSsmlForGoogle(input);
    expect(chunks).toHaveLength(1);
  });
});

describe('chunkSsmlForGoogle — oversized sections', () => {
  it('falls back to sentence-level splits when one section exceeds the limit', () => {
    const longSection = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1}.`).join(' ');
    const input = `<speak>${longSection}</speak>`;
    const chunks = chunkSsmlForGoogle(input, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(looksLikeValidSpeakBlock(c)).toBe(true);
      expect(bytes(c)).toBeLessThanOrEqual(100);
    }
  });

  it('handles realistic 14k-char SSML narration (sections separated by 2s breaks)', () => {
    // Roughly mirrors the user's reported script: 27 sections, each
    // ~550 chars, separated by <break time="2s"/>.
    const section = (i: number) =>
      `Section ${i}. ${Array.from({ length: 8 }, (_, j) => `This is sentence ${j + 1} of section ${i}.`).join(' ')}`;
    const sections = Array.from({ length: 27 }, (_, i) => section(i + 1));
    const input = `<speak>${sections.join(' <break time="2s"/> ')}</speak>`;
    const chunks = chunkSsmlForGoogle(input);
    // Expect chunks roughly one per section since each fits in
    // <speak> overhead + ~550 bytes well under the default 4500.
    expect(chunks.length).toBeGreaterThanOrEqual(20);
    expect(chunks.length).toBeLessThanOrEqual(30);
    for (const c of chunks) {
      expect(looksLikeValidSpeakBlock(c)).toBe(true);
      expect(bytes(c)).toBeLessThanOrEqual(4500);
    }
  });
});

describe('chunkSsmlForGoogle — inputs without <speak> wrapper', () => {
  it('handles SSML fragments missing the outer <speak> tag', () => {
    const input = 'Plain segment one. <break time="2s"/> Plain segment two.';
    const chunks = chunkSsmlForGoogle(input, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(looksLikeValidSpeakBlock(c)).toBe(true);
  });
});

describe('chunkSsmlForGoogle — degenerate inputs', () => {
  it('returns empty array on empty <speak>', () => {
    expect(chunkSsmlForGoogle('<speak></speak>')).toEqual([]);
  });

  it('returns empty array on input that strips to nothing', () => {
    expect(chunkSsmlForGoogle('   ')).toEqual([]);
  });
});
