import { describe, expect, it } from 'vitest';
import {
  applyGainPcm16,
  normalizeChunks,
  rmsPcm16,
  rmsToDb,
} from '@/lib/tts/pcm-normalize';

// Pins behavior of the per-chunk PCM volume normalizer that handles
// Chirp 3 HD's per-call amplitude variance. Without this, chunks that
// come back unusually quiet from the synthesis API stay quiet in the
// final voiceover — and the user hears "voice quality drops mid-way."

function makeTone(amplitude: number, sampleCount = 1000): Uint8Array {
  // Constant-amplitude square-ish wave: alternates +amp / -amp every
  // sample. Provides a deterministic RMS for testing without floating-
  // point error in the test math.
  const buf = new Uint8Array(sampleCount * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < sampleCount; i++) {
    view.setInt16(i * 2, i % 2 === 0 ? amplitude : -amplitude, true);
  }
  return buf;
}

describe('rmsPcm16', () => {
  it('returns 0 for empty input', () => {
    expect(rmsPcm16(new Uint8Array(0))).toBe(0);
    expect(rmsPcm16(new Uint8Array(1))).toBe(0);  // less than one sample
  });

  it('computes the RMS of a constant-amplitude square wave', () => {
    // amp 16384 in [-32768, 32767] = 0.5 normalized. RMS of ±0.5 = 0.5.
    const tone = makeTone(16384);
    expect(rmsPcm16(tone)).toBeCloseTo(0.5, 4);
  });

  it('returns full-scale RMS for max-amplitude tone', () => {
    const tone = makeTone(32767);
    // 32767/32768 ≈ 0.99997
    expect(rmsPcm16(tone)).toBeCloseTo(0.99997, 4);
  });
});

describe('rmsToDb', () => {
  it('converts linear RMS to dBFS', () => {
    expect(rmsToDb(1)).toBeCloseTo(0, 6);
    expect(rmsToDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(rmsToDb(0.1)).toBeCloseTo(-20, 1);
  });
  it('returns -Infinity for zero RMS', () => {
    expect(rmsToDb(0)).toBe(-Infinity);
  });
});

describe('applyGainPcm16 — gain + clipping', () => {
  it('passes through when gain === 1', () => {
    const tone = makeTone(1000);
    const out = applyGainPcm16(tone, 1);
    expect(out).toBe(tone);  // same reference (optimization)
  });

  it('multiplies samples by the gain factor', () => {
    const tone = makeTone(1000);
    const out = applyGainPcm16(tone, 2);
    const view = new DataView(out.buffer);
    expect(view.getInt16(0, true)).toBe(2000);
    expect(view.getInt16(2, true)).toBe(-2000);
  });

  it('hard-clips samples that would exceed int16 range', () => {
    const tone = makeTone(20000);  // already loud
    const out = applyGainPcm16(tone, 3);  // would scale to ±60000, clip to ±32767/-32768
    const view = new DataView(out.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });
});

describe('normalizeChunks — the actual bug fix', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeChunks([])).toEqual([]);
  });

  it('leaves a single chunk untouched (no median to compare against)', () => {
    const chunk = makeTone(10000);
    const out = normalizeChunks([chunk]);
    expect(out).toHaveLength(1);
    expect(out[0].appliedGain).toBe(1);
    expect(out[0].pcm).toBe(chunk);
  });

  it('does not amplify chunks within 6 dB of the median', () => {
    // Three chunks at similar amplitudes — all within tolerance.
    const a = makeTone(10000);
    const b = makeTone(11000);
    const c = makeTone(9000);
    const out = normalizeChunks([a, b, c]);
    for (const r of out) {
      expect(r.appliedGain).toBe(1);
    }
  });

  it('amplifies chunks more than 6 dB below the median (the actual user case)', () => {
    // Mimics the user's voiceover: 5 chunks, normal volume except
    // two that are 14 dB quieter (matches the -33 dB vs -19 dB
    // pattern in the real file).
    const normal1 = makeTone(10000);
    const normal2 = makeTone(10500);
    const quiet = makeTone(2000);  // ~14 dB below
    const normal3 = makeTone(9800);
    const out = normalizeChunks([normal1, normal2, quiet, normal3]);
    expect(out[0].appliedGain).toBe(1);
    expect(out[1].appliedGain).toBe(1);
    expect(out[2].appliedGain).toBeGreaterThan(1);  // amplified
    expect(out[3].appliedGain).toBe(1);
    // After applying gain, the quiet chunk's RMS should be closer to median.
    const liftedRms = rmsPcm16(out[2].pcm);
    const originalQuietRms = rmsPcm16(quiet);
    const medianRms = rmsPcm16(normal2);
    expect(rmsToDb(liftedRms)).toBeGreaterThan(rmsToDb(originalQuietRms));
    // Gain is capped at +6 dB to prevent runaway amplification. A
    // chunk that started 14 dB below median ends up ~8 dB below — a
    // noticeable improvement but not full equalization. Tradeoff is
    // deliberate: lifting all the way to median for a very-quiet
    // chunk would mean ~14 dB of gain, which would amplify noise
    // floor and any synthesis artifacts.
    const liftedDeltaFromMedian = Math.abs(rmsToDb(liftedRms) - rmsToDb(medianRms));
    const originalDeltaFromMedian = Math.abs(rmsToDb(originalQuietRms) - rmsToDb(medianRms));
    expect(liftedDeltaFromMedian).toBeLessThan(originalDeltaFromMedian);  // improved
  });

  it('caps applied gain at 2x (+6 dB) to prevent runaway amplification', () => {
    // One very loud chunk + several near-silent. The "quiet" chunks
    // would need 10x+ gain to match the loud one. The cap prevents
    // that to avoid amplifying noise floor / artifacts.
    const loud = makeTone(30000);
    const quiet1 = makeTone(300);
    const quiet2 = makeTone(280);
    const out = normalizeChunks([loud, quiet1, quiet2]);
    for (const r of out) {
      expect(r.appliedGain).toBeLessThanOrEqual(2.0001);
    }
  });

  it('does not get fooled by near-silent chunks polluting the median', () => {
    // If one chunk is essentially silence (e.g. a section consisting
    // entirely of a long <break>), it shouldn't drag the median
    // down and cause normal chunks to look "loud" by comparison.
    const silence = new Uint8Array(2000);  // all zeros → RMS = 0
    const normal1 = makeTone(10000);
    const normal2 = makeTone(10500);
    const out = normalizeChunks([normal1, silence, normal2]);
    expect(out[0].appliedGain).toBe(1);
    expect(out[2].appliedGain).toBe(1);
    // Silent chunk gets no gain (gain on zero RMS = NaN / infinity).
    expect(out[1].appliedGain).toBe(1);
  });
});
