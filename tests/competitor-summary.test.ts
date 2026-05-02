import { describe, expect, it } from 'vitest';
import { classifyOutlier, computeMomentum } from '@/lib/competitor-summary';

describe('computeMomentum', () => {
  it('returns the ratio of this-week to prior-week uploads', () => {
    expect(computeMomentum(4, 2)).toBe(2);
    expect(computeMomentum(2, 2)).toBe(1);
    expect(computeMomentum(1, 2)).toBe(0.5);
  });

  it('returns null when prior is 0 and this-week is positive (infinite ratio)', () => {
    expect(computeMomentum(3, 0)).toBeNull();
  });

  it('returns 0 when both windows are empty (no signal, not "infinite")', () => {
    expect(computeMomentum(0, 0)).toBe(0);
  });

  it('treats negative prior as no-signal (defensive — should never happen)', () => {
    expect(computeMomentum(2, -1)).toBeNull();
  });
});

describe('classifyOutlier', () => {
  it('null factor → normal (no baseline)', () => {
    expect(classifyOutlier(null)).toBe('normal');
  });

  it('thresholds at 2.5 (breakout) and 5 (viral)', () => {
    expect(classifyOutlier(1)).toBe('normal');
    expect(classifyOutlier(2.49)).toBe('normal');
    expect(classifyOutlier(2.5)).toBe('breakout');
    expect(classifyOutlier(4.99)).toBe('breakout');
    expect(classifyOutlier(5)).toBe('viral');
    expect(classifyOutlier(50)).toBe('viral');
  });
});
