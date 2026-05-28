import { describe, expect, it } from 'vitest';
import {
  constantRateVisemeSequence,
  visemeSequenceFromAlignment,
  type VisemeWord,
} from '@/lib/viseme-from-alignment';

// ─── visemeSequenceFromAlignment ─────────────────────────────────────

describe('visemeSequenceFromAlignment', () => {
  it('returns an empty array when rowDurationMs is zero or negative', () => {
    expect(
      visemeSequenceFromAlignment({
        rowStartMs: 0,
        rowDurationMs: 0,
        words: [],
        fps: 30,
      }),
    ).toEqual([]);
    expect(
      visemeSequenceFromAlignment({
        rowStartMs: 0,
        rowDurationMs: -100,
        words: [],
        fps: 30,
      }),
    ).toEqual([]);
  });

  it('returns an empty array when fps is zero or negative', () => {
    expect(
      visemeSequenceFromAlignment({
        rowStartMs: 0,
        rowDurationMs: 1000,
        words: [],
        fps: 0,
      }),
    ).toEqual([]);
  });

  it('produces a sequence of length round(rowDurationMs/1000 * fps)', () => {
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1000, // 1 second
      words: [],
      fps: 30,
    });
    expect(seq).toHaveLength(30);
  });

  it("emits 'open' for frames inside a word's window", () => {
    // Single word from 100ms..900ms in a 1000ms row at 30fps. Frames
    // 4..27 should be 'open' (frame_ms = i * 33.33). Frame 3 = 100ms,
    // frame 4 = 133.33ms (inside); frame 26 = 866.66ms (inside);
    // frame 27 = 900ms (boundary — endMs is exclusive in the helper).
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1000,
      words: [{ text: 'hi', startMs: 100, endMs: 900 }],
      fps: 30,
    });
    // Spot-check a clearly-inside frame.
    expect(seq[10]).toBe('open');
    expect(seq[20]).toBe('open');
  });

  it("emits 'mid' for short pauses between words (≤ 500ms)", () => {
    // 200ms gap between two words — well under the 500ms LONG_PAUSE
    // threshold, so the gap should render as 'mid'. Frame at ~600ms
    // (i.e. mid-gap) should be 'mid'.
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1500,
      words: [
        { text: 'first', startMs: 0, endMs: 500 },
        { text: 'second', startMs: 700, endMs: 1500 },
      ],
      fps: 30,
    });
    // Frame 18 = 600ms — strictly inside the 500..700 gap.
    expect(seq[18]).toBe('mid');
  });

  it("emits 'closed' for long pauses (> 500ms)", () => {
    // 800ms gap — above the 500ms threshold, so 'closed'.
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 2000,
      words: [
        { text: 'first', startMs: 0, endMs: 200 },
        { text: 'second', startMs: 1000, endMs: 1400 },
      ],
      fps: 30,
    });
    // Frame 18 = 600ms — strictly inside the 200..1000 long gap.
    expect(seq[18]).toBe('closed');
  });

  it("emits 'closed' before the first word when the lead-in is long", () => {
    // Lead-in is 1000ms before the first word — over LONG_PAUSE.
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 2000,
      words: [{ text: 'late', startMs: 1000, endMs: 1500 }],
      fps: 30,
    });
    expect(seq[0]).toBe('closed');
    expect(seq[10]).toBe('closed'); // 333ms — still well before the word
  });

  it("emits 'closed' after the last word when the tail silence is long", () => {
    // Tail silence is 900ms after the word ends — over LONG_PAUSE.
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1500,
      words: [{ text: 'early', startMs: 0, endMs: 600 }],
      fps: 30,
    });
    // Frame 35 = 1166ms — well into the tail silence.
    expect(seq[35]).toBe('closed');
  });

  it('clips word intervals to the row window', () => {
    // Word ends past row boundary — the part inside the row should
    // still register as 'open'.
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1000,
      words: [{ text: 'overflow', startMs: 500, endMs: 5000 }],
      fps: 30,
    });
    // Frame 20 = 666ms — inside the clipped word window.
    expect(seq[20]).toBe('open');
  });

  it('respects an explicit non-zero rowStartMs (absolute-time alignment)', () => {
    // Row spans the audio's 10s..11s window. The word also lives there.
    // Helper expects all timestamps in the SAME clock, so the comparison
    // is frameMs (absolute) against word.startMs (absolute). Output is
    // STILL indexed from 0 (the row's local frame 0 = audio's 10s).
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 10_000,
      rowDurationMs: 1000,
      words: [{ text: 'mid', startMs: 10_300, endMs: 10_700 }],
      fps: 30,
    });
    // Frame 15 of the row = 10s + 500ms = 10_500ms — inside the word.
    expect(seq[15]).toBe('open');
  });

  it('drops empty / zero-duration words rather than treating them as silent', () => {
    // A zero-duration word at the middle of the row shouldn't make
    // anything 'open' — it gets filtered. The whole row should be
    // 'closed' (single ≥500ms silence).
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1000,
      words: [{ text: '', startMs: 500, endMs: 500 }],
      fps: 30,
    });
    expect(seq[15]).toBe('closed');
    expect(seq.every((s) => s === 'closed')).toBe(true);
  });

  it('handles unordered word input by sorting internally', () => {
    // Words given out of order — output should still be deterministic.
    const words: VisemeWord[] = [
      { text: 'b', startMs: 700, endMs: 900 },
      { text: 'a', startMs: 100, endMs: 300 },
    ];
    const seq = visemeSequenceFromAlignment({
      rowStartMs: 0,
      rowDurationMs: 1000,
      words,
      fps: 30,
    });
    expect(seq[6]).toBe('open'); // 200ms — inside word "a"
    expect(seq[24]).toBe('open'); // 800ms — inside word "b"
    // 500ms gap (300..700) is exactly at the threshold; helper uses
    // strict > 500, so 400ms gap counts as 'mid'. Frame 15 = 500ms
    // boundary; check frame 13 (433ms) for clarity.
    expect(seq[13]).toBe('mid');
  });
});

// ─── constantRateVisemeSequence ──────────────────────────────────────

describe('constantRateVisemeSequence', () => {
  it('returns empty array on non-positive durationFrames', () => {
    expect(constantRateVisemeSequence({ durationFrames: 0, fps: 30 })).toEqual([]);
    expect(constantRateVisemeSequence({ durationFrames: -1, fps: 30 })).toEqual([]);
  });

  it('returns empty array on non-positive fps', () => {
    expect(constantRateVisemeSequence({ durationFrames: 30, fps: 0 })).toEqual([]);
  });

  it('produces a sequence of exactly durationFrames length', () => {
    expect(constantRateVisemeSequence({ durationFrames: 30, fps: 30 })).toHaveLength(30);
    expect(constantRateVisemeSequence({ durationFrames: 90, fps: 30 })).toHaveLength(90);
  });

  it("cycles mid ↔ open at the default 8Hz rate", () => {
    // At 30 fps with rateHz=8, framesPerState = round(30/8) = 4.
    // So frames 0..3 = 'mid', 4..7 = 'open', 8..11 = 'mid', …
    const seq = constantRateVisemeSequence({ durationFrames: 16, fps: 30 });
    expect(seq[0]).toBe('mid');
    expect(seq[3]).toBe('mid');
    expect(seq[4]).toBe('open');
    expect(seq[7]).toBe('open');
    expect(seq[8]).toBe('mid');
    expect(seq[15]).toBe('open');
  });

  it('honours an explicit rateHz when provided', () => {
    // At 30fps with rateHz=15, framesPerState = round(30/15) = 2.
    // So every 2 frames flips state.
    const seq = constantRateVisemeSequence({
      durationFrames: 8,
      fps: 30,
      rateHz: 15,
    });
    expect(seq[0]).toBe('mid');
    expect(seq[1]).toBe('mid');
    expect(seq[2]).toBe('open');
    expect(seq[3]).toBe('open');
    expect(seq[4]).toBe('mid');
  });

  it('clamps rateHz below 2 up to 2 (no strobe at frame rate)', () => {
    // rateHz=0.5 would mean one flip per 60 frames @ 30fps — too slow.
    // Helper clamps to 2Hz. At 30fps that's framesPerState = 15.
    const seq = constantRateVisemeSequence({
      durationFrames: 30,
      fps: 30,
      rateHz: 0.5,
    });
    expect(seq[0]).toBe('mid');
    expect(seq[14]).toBe('mid');
    expect(seq[15]).toBe('open');
    expect(seq[29]).toBe('open');
  });

  it('clamps rateHz above 24 down to 24 (no strobe at frame rate)', () => {
    // rateHz=120 would mean a flip every 0.25 frames @ 30fps — meaningless.
    // Helper clamps to 24Hz. At 30fps that's framesPerState = round(30/24) = 1.
    const seq = constantRateVisemeSequence({
      durationFrames: 6,
      fps: 30,
      rateHz: 120,
    });
    // With framesPerState = 1, the cycle flips every frame.
    expect(seq[0]).toBe('mid');
    expect(seq[1]).toBe('open');
    expect(seq[2]).toBe('mid');
    expect(seq[3]).toBe('open');
  });

  it('floors framesPerState at 1 (no division by zero on tiny fps)', () => {
    // At fps=1 rateHz=24, the unclamped value would be ~0.04 frames per
    // state — meaningless. The helper floors framesPerState at 1.
    const seq = constantRateVisemeSequence({
      durationFrames: 4,
      fps: 1,
      rateHz: 24,
    });
    expect(seq).toHaveLength(4);
    // With framesPerState=1, output flips every frame: mid, open, mid, open.
    expect(seq).toEqual(['mid', 'open', 'mid', 'open']);
  });
});
