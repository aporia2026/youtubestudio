import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FPS,
  assertFps,
  framesToMs,
  framesToSec,
  msToFrames,
  msToSec,
  secToFrames,
  secToMs,
  snapMsToFrame,
  snapSecToFrame,
} from '@/lib/timeline-editor/frame-math';

describe('frame-math — round-trip conversions', () => {
  it('ms ↔ seconds is exact', () => {
    expect(msToSec(1000)).toBe(1);
    expect(msToSec(33)).toBe(0.033);
    expect(secToMs(0.5)).toBe(500);
    expect(secToMs(msToSec(7777))).toBe(7777);
  });

  it('ms ↔ frames at 30 fps', () => {
    expect(msToFrames(1000, 30)).toBe(30);
    expect(framesToMs(30, 30)).toBe(1000);
    expect(framesToMs(1, 30)).toBeCloseTo(33.333, 2);
  });

  it('ms ↔ frames at 60 fps', () => {
    expect(msToFrames(1000, 60)).toBe(60);
    expect(framesToMs(60, 60)).toBe(1000);
    expect(framesToMs(1, 60)).toBeCloseTo(16.667, 2);
  });

  it('seconds ↔ frames at 24 fps (film)', () => {
    expect(secToFrames(1, 24)).toBe(24);
    expect(framesToSec(24, 24)).toBe(1);
  });

  it('defaults to 30 fps when fps argument omitted', () => {
    expect(msToFrames(1000)).toBe(30);
    expect(framesToMs(30)).toBe(1000);
    expect(DEFAULT_FPS).toBe(30);
  });
});

describe('frame-math — snapping', () => {
  it('snaps ms within half a frame to the nearest frame boundary', () => {
    // At 30fps: one frame = 33.333ms. Snap of 35ms should land on 33.333ms (frame 1).
    expect(snapMsToFrame(35, 30)).toBeCloseTo(33.333, 2);
    // 50ms is closer to frame 2 (66.666ms) than frame 1 (33.333ms).
    expect(snapMsToFrame(50, 30)).toBeCloseTo(66.667, 2);
    // 16ms is closer to frame 0 than frame 1.
    expect(snapMsToFrame(16, 30)).toBe(0);
    // 17ms is right at the midpoint; rounds up to frame 1.
    expect(snapMsToFrame(17, 30)).toBeCloseTo(33.333, 2);
  });

  it('snaps seconds to the nearest frame at 60 fps', () => {
    // 0.01s × 60fps = 0.6 frame → rounds to 1 frame → 1/60 = 0.01667s.
    expect(snapSecToFrame(0.01, 60)).toBeCloseTo(1 / 60, 4);
    // 0.008s × 60fps = 0.48 frame → rounds to 0 → 0s.
    expect(snapSecToFrame(0.008, 60)).toBe(0);
    expect(snapSecToFrame(0.5, 60)).toBe(0.5); // 30 frames exactly
    expect(snapSecToFrame(0.503, 60)).toBeCloseTo(0.5, 2);
  });

  it('snapping is idempotent', () => {
    const snapped = snapMsToFrame(123.456, 30);
    expect(snapMsToFrame(snapped, 30)).toBe(snapped);
  });
});

describe('frame-math — assertFps', () => {
  it('accepts 24, 30, 60', () => {
    expect(() => assertFps(24)).not.toThrow();
    expect(() => assertFps(30)).not.toThrow();
    expect(() => assertFps(60)).not.toThrow();
  });

  it('rejects out-of-range and non-finite values', () => {
    expect(() => assertFps(0)).toThrow();
    expect(() => assertFps(-1)).toThrow();
    expect(() => assertFps(200)).toThrow();
    expect(() => assertFps(Number.NaN)).toThrow();
    expect(() => assertFps(Number.POSITIVE_INFINITY)).toThrow();
  });
});
