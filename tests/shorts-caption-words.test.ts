/**
 * Unit tests for the per-word timing helpers behind the karaoke /
 * word-highlight caption effects.
 *
 * Plan: `_plans/2026-06-04-shorts-caption-word-effects.md`.
 */
import { describe, expect, it } from 'vitest';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import type { ShortCaptionChunk } from '@/lib/shorts-render-types';
import {
  attachWordTimingsToChunks,
  findActiveWordIndex,
  wordPositionAt,
} from '@/lib/shorts-caption-words';

function chunk(text: string, startMs: number, endMs: number): ShortCaptionChunk {
  return { text, start_ms: startMs, end_ms: endMs };
}

function alignment(
  words: Array<{ text: string; start: number; end: number }>,
): ForcedAlignmentResponse {
  return { words };
}

describe('attachWordTimingsToChunks', () => {
  it('returns chunks with proportional word timings when alignment is missing', () => {
    const chunks = [chunk('hello there friend', 0, 3000)];
    const result = attachWordTimingsToChunks(chunks, null);
    expect(result[0]!.words).toEqual([
      { text: 'hello', start_ms: 0, end_ms: 1000 },
      { text: 'there', start_ms: 1000, end_ms: 2000 },
      { text: 'friend', start_ms: 2000, end_ms: 3000 },
    ]);
  });

  it('returns chunks with proportional word timings when alignment is empty', () => {
    const chunks = [chunk('hello there', 0, 2000)];
    const result = attachWordTimingsToChunks(chunks, alignment([]));
    expect(result[0]!.words).toEqual([
      { text: 'hello', start_ms: 0, end_ms: 1000 },
      { text: 'there', start_ms: 1000, end_ms: 2000 },
    ]);
  });

  it('snaps to alignment timings when they match the script word-for-word', () => {
    const chunks = [chunk('hello there friend', 0, 3000)];
    const align = alignment([
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'there', start: 0.6, end: 1.0 },
      { text: 'friend', start: 1.2, end: 1.8 },
    ]);
    const result = attachWordTimingsToChunks(chunks, align);
    expect(result[0]!.words).toEqual([
      { text: 'hello', start_ms: 100, end_ms: 500 },
      { text: 'there', start_ms: 600, end_ms: 1000 },
      { text: 'friend', start_ms: 1200, end_ms: 1800 },
    ]);
  });

  it('matches across chunks: cursor advances so chunk N starts where chunk N-1 ended', () => {
    const chunks = [chunk('hello there', 0, 2000), chunk('friend', 2000, 3000)];
    const align = alignment([
      { text: 'hello', start: 0.0, end: 0.5 },
      { text: 'there', start: 0.5, end: 1.0 },
      { text: 'friend', start: 2.0, end: 2.6 },
    ]);
    const result = attachWordTimingsToChunks(chunks, align);
    expect(result[0]!.words!.map((w) => w.text)).toEqual(['hello', 'there']);
    expect(result[1]!.words!).toEqual([
      { text: 'friend', start_ms: 2000, end_ms: 2600 },
    ]);
  });

  it('normalizes punctuation when matching (Password! vs password)', () => {
    const chunks = [chunk('Password! Yes.', 0, 1500)];
    const align = alignment([
      { text: 'password', start: 0.0, end: 0.7 },
      { text: 'yes', start: 0.9, end: 1.3 },
    ]);
    const result = attachWordTimingsToChunks(chunks, align);
    // Punctuation preserved in the rendered text, but timing matched.
    expect(result[0]!.words![0]!.text).toBe('Password!');
    expect(result[0]!.words![0]!.start_ms).toBe(0);
    expect(result[0]!.words![0]!.end_ms).toBe(700);
    expect(result[0]!.words![1]!.text).toBe('Yes.');
    expect(result[0]!.words![1]!.start_ms).toBe(900);
    expect(result[0]!.words![1]!.end_ms).toBe(1300);
  });

  it('uses lookahead to absorb minor drift (one missing alignment word)', () => {
    // The aligner sometimes drops a tiny word ("a", "the"). The walk
    // should skip ahead to find the next match rather than nuke
    // everything from that point on.
    const chunks = [chunk('crack a code', 0, 3000)];
    const align = alignment([
      { text: 'crack', start: 0.0, end: 0.6 },
      // "a" missing from alignment
      { text: 'code', start: 1.0, end: 1.6 },
    ]);
    const result = attachWordTimingsToChunks(chunks, align);
    // 'crack' + 'code' snap to alignment; 'a' falls back to proportional.
    const w = result[0]!.words!;
    expect(w[0]!).toEqual({ text: 'crack', start_ms: 0, end_ms: 600 });
    // 'a' is the proportional fallback.
    expect(w[1]!.text).toBe('a');
    expect(w[2]!).toEqual({ text: 'code', start_ms: 1000, end_ms: 1600 });
  });

  it('clamps word boundaries to the chunk bounds so a slightly off-alignment word stays inside', () => {
    // Aligner says "friend" ends at 4.0s but the chunk only runs to 3s.
    // The clamp keeps it inside.
    const chunks = [chunk('hello friend', 0, 3000)];
    const align = alignment([
      { text: 'hello', start: 0.0, end: 0.6 },
      { text: 'friend', start: 0.7, end: 4.0 },
    ]);
    const result = attachWordTimingsToChunks(chunks, align);
    expect(result[0]!.words![1]!.end_ms).toBe(3000);
  });

  it('handles an empty chunk text', () => {
    const result = attachWordTimingsToChunks([chunk('', 0, 1000)], null);
    expect(result[0]!.words).toEqual([]);
  });
});

describe('findActiveWordIndex', () => {
  const words = [
    { start_ms: 0, end_ms: 500 },
    { start_ms: 500, end_ms: 1000 },
    { start_ms: 1200, end_ms: 1800 },
  ];

  it('returns the index of the word whose window contains elapsedMs', () => {
    expect(findActiveWordIndex(words, 250)).toBe(0);
    expect(findActiveWordIndex(words, 600)).toBe(1);
    expect(findActiveWordIndex(words, 1500)).toBe(2);
  });

  it('treats start_ms as inclusive, end_ms as exclusive', () => {
    expect(findActiveWordIndex(words, 0)).toBe(0);
    expect(findActiveWordIndex(words, 500)).toBe(1);
    expect(findActiveWordIndex(words, 1000)).toBe(-1); // gap between words
  });

  it('returns -1 before the first word', () => {
    expect(findActiveWordIndex(words, -100)).toBe(-1);
  });

  it('returns -1 after the last word', () => {
    expect(findActiveWordIndex(words, 2000)).toBe(-1);
  });

  it('returns -1 in a silent gap between words', () => {
    expect(findActiveWordIndex(words, 1100)).toBe(-1);
  });

  it('returns -1 on an empty words array', () => {
    expect(findActiveWordIndex([], 100)).toBe(-1);
  });
});

describe('wordPositionAt', () => {
  const words = [
    { start_ms: 0, end_ms: 500 },
    { start_ms: 500, end_ms: 1000 },
    { start_ms: 1200, end_ms: 1800 },
  ];

  it('returns active when the playhead is inside the word', () => {
    expect(wordPositionAt(words, 300, 0)).toBe('active');
    expect(wordPositionAt(words, 700, 1)).toBe('active');
  });

  it('returns spoken when the playhead is past the word', () => {
    expect(wordPositionAt(words, 600, 0)).toBe('spoken');
    expect(wordPositionAt(words, 1500, 1)).toBe('spoken');
  });

  it('returns upcoming when the playhead is before the word', () => {
    expect(wordPositionAt(words, 100, 1)).toBe('upcoming');
    expect(wordPositionAt(words, 100, 2)).toBe('upcoming');
  });

  it('returns spoken in a silent gap for words that already ended', () => {
    // At 1100ms (between word 1 and 2), word 0 + 1 are spoken.
    expect(wordPositionAt(words, 1100, 0)).toBe('spoken');
    expect(wordPositionAt(words, 1100, 1)).toBe('spoken');
    expect(wordPositionAt(words, 1100, 2)).toBe('upcoming');
  });

  it('returns upcoming when wordIndex is out of bounds', () => {
    expect(wordPositionAt(words, 100, 5)).toBe('upcoming');
  });
});
