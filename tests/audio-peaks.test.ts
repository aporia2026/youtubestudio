import { describe, expect, it } from 'vitest';
import { slicePeaks } from '@/lib/timeline-editor/audio-peaks';

// The pure slicer is the only piece of audio-peaks.ts that doesn't
// require a browser AudioContext — these tests freeze its contract.
// The Web Audio side (decodeAudioPeaks) is exercised end-to-end in
// the browser; we can't unit-test it without a JSDOM AudioContext
// shim, which would test the shim more than our code.

function range(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i / (n - 1); // 0..1
  return out;
}

describe('slicePeaks', () => {
  it('returns the slice covering the supplied ms range', () => {
    // 1000ms source, 1000 buckets (1 bucket per ms). Slice 200-700ms
    // = 50% of the source.
    const peaks = range(1000);
    const out = slicePeaks(peaks, 200, 500, 1000, 100);
    expect(out).toHaveLength(100);
    // The first bucket of the slice should be near the value at
    // source index 200 (= 0.2).
    expect(out[0]).toBeCloseTo(0.2, 2);
    // The last bucket should be near the value at source index 700
    // (= 0.7).
    expect(out[out.length - 1]).toBeCloseTo(0.69, 1);
  });

  it('produces the requested outBucket count regardless of source length', () => {
    const peaks = range(1000);
    expect(slicePeaks(peaks, 0, 1000, 1000, 12)).toHaveLength(12);
    expect(slicePeaks(peaks, 0, 1000, 1000, 50)).toHaveLength(50);
    expect(slicePeaks(peaks, 0, 1000, 1000, 200)).toHaveLength(200);
  });

  it('clamps sourceOffsetMs + durationMs to source bounds', () => {
    const peaks = range(1000);
    // Asking for [-500, 500] should clamp the start to 0.
    const startClamped = slicePeaks(peaks, -500, 1000, 1000, 100);
    expect(startClamped[0]).toBe(peaks[0]);
    // Asking for [800, 999] (extends past end) should clamp end.
    const endClamped = slicePeaks(peaks, 800, 500, 1000, 100);
    expect(endClamped[endClamped.length - 1]).toBeCloseTo(0.998, 2);
  });

  it('returns a zero-filled array of the requested size when inputs are degenerate', () => {
    const peaks = new Float32Array(0);
    const out = slicePeaks(peaks, 0, 100, 100, 20);
    expect(out).toHaveLength(20);
    for (let i = 0; i < 20; i++) expect(out[i]).toBe(0);
  });

  it('returns an empty array when outBuckets <= 0', () => {
    const peaks = range(100);
    expect(slicePeaks(peaks, 0, 100, 100, 0)).toHaveLength(0);
    expect(slicePeaks(peaks, 0, 100, 100, -5)).toHaveLength(0);
  });

  it('handles zero-or-negative durationMs by returning zero-filled', () => {
    const peaks = range(100);
    const out = slicePeaks(peaks, 50, 0, 100, 10);
    expect(out).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(out[i]).toBe(0);
  });
});
