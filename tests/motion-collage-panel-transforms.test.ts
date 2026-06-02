/**
 * Unit tests for the per-panel motion-collage transform sanitizer.
 *
 * User-asked-for (2026-06-02): per-panel image transform (X/Y/SCALE)
 * so a poorly-framed AI panel can be repositioned inside its viewport
 * without regenerating. The sanitizer is the payload-boundary defense
 * (Rule 13): client-written numbers get clamped to safe bounds before
 * they reach the renderer.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeMotionCollagePanelTransforms } from '@/lib/project/payload';

describe('sanitizeMotionCollagePanelTransforms — bounds + null handling', () => {
  it('returns empty + unchanged for undefined / null input', () => {
    expect(sanitizeMotionCollagePanelTransforms(undefined)).toEqual({
      value: [],
      changed: false,
      note: '',
    });
    expect(sanitizeMotionCollagePanelTransforms(null)).toEqual({
      value: [],
      changed: false,
      note: '',
    });
  });

  it('rejects non-array values', () => {
    const r = sanitizeMotionCollagePanelTransforms({ x_pct: 10 });
    expect(r.value).toEqual([]);
    expect(r.changed).toBe(true);
    expect(r.note).toContain('not-array');
  });

  it('preserves null entries verbatim (default panels)', () => {
    const r = sanitizeMotionCollagePanelTransforms([null, null, null]);
    expect(r.value).toEqual([null, null, null]);
    expect(r.changed).toBe(false);
  });

  it('keeps valid in-range values', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      { x_pct: 10, y_pct: -20, scale_pct: 120 },
    ]);
    expect(r.value).toEqual([{ x_pct: 10, y_pct: -20, scale_pct: 120 }]);
    expect(r.changed).toBe(false);
  });

  it('clamps x_pct / y_pct over 100 down to 100', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      { x_pct: 9999, y_pct: -9999 },
    ]);
    expect(r.value[0]).toEqual({ x_pct: 100, y_pct: -100 });
    expect(r.changed).toBe(true);
    expect(r.note).toContain('clamped');
  });

  it('clamps scale_pct to [25, 400]', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      { scale_pct: 5 },
      { scale_pct: 1000 },
    ]);
    expect(r.value[0]).toEqual({ scale_pct: 25 });
    expect(r.value[1]).toEqual({ scale_pct: 400 });
    expect(r.changed).toBe(true);
  });

  it('drops NaN / non-finite values without breaking the entry', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      { x_pct: NaN, y_pct: Infinity, scale_pct: 100 },
    ]);
    expect(r.value[0]).toEqual({ scale_pct: 100 });
    expect(r.changed).toBe(true);
  });

  it('collapses all-default entries to null (renderer short-circuits)', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      { x_pct: undefined, y_pct: undefined, scale_pct: undefined },
      {},
    ]);
    expect(r.value).toEqual([null, null]);
  });

  it('drops malformed (non-object) entries to null', () => {
    const r = sanitizeMotionCollagePanelTransforms([
      'not an object',
      42,
      { x_pct: 10 },
    ]);
    expect(r.value[0]).toBe(null);
    expect(r.value[1]).toBe(null);
    expect(r.value[2]).toEqual({ x_pct: 10 });
    expect(r.changed).toBe(true);
    expect(r.note).toContain('dropped');
  });

  it('caps the array at maxLength (16)', () => {
    const tooMany = Array.from({ length: 20 }, () => ({ x_pct: 1 }));
    const r = sanitizeMotionCollagePanelTransforms(tooMany);
    expect(r.value).toHaveLength(16);
    expect(r.changed).toBe(true);
    expect(r.note).toContain('over-cap');
  });
});
