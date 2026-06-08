/**
 * Unit tests for the per-row channel-style ref slicer.
 *
 * The slicer rotates a fixed-size window through a larger pool so
 * adjacent rows share style anchors while distant rows pull fresh
 * frames. Critical properties:
 *   - Pool size <= slice size → return the pool unchanged.
 *   - Pool size > slice size → return exactly `sliceSize` items.
 *   - Adjacent rows share 2+ items (continuity).
 *   - Distant rows share fewer items (variety).
 *   - Negative / unknown row index falls back gracefully.
 */

import { describe, expect, it } from 'vitest';
import { pickPerRowRefSlice } from '@/lib/auto-pipeline/production-doc-image-gen';

describe('pickPerRowRefSlice', () => {
  it('returns the empty pool unchanged', () => {
    expect(pickPerRowRefSlice([], 0, 4)).toEqual([]);
    expect(pickPerRowRefSlice([], 5, 4)).toEqual([]);
  });

  it('returns the pool unchanged when smaller than the slice', () => {
    const pool = ['a', 'b', 'c'];
    expect(pickPerRowRefSlice(pool, 0, 4)).toEqual(['a', 'b', 'c']);
    expect(pickPerRowRefSlice(pool, 99, 4)).toEqual(['a', 'b', 'c']);
  });

  it('returns exactly sliceSize items when the pool is larger', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(pickPerRowRefSlice(pool, 0, 4)).toHaveLength(4);
    expect(pickPerRowRefSlice(pool, 7, 4)).toHaveLength(4);
  });

  it('rotates the window with a stride so adjacent rows overlap', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const row0 = pickPerRowRefSlice(pool, 0, 4);
    const row1 = pickPerRowRefSlice(pool, 1, 4);
    // Stride 2 + slice 4 → adjacent rows share 2 of 4.
    const sharedAdjacent = row0.filter((x) => row1.includes(x)).length;
    expect(sharedAdjacent).toBe(2);
  });

  it('distant rows share fewer items than adjacent rows', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const row0 = pickPerRowRefSlice(pool, 0, 4);
    const rowDistant = pickPerRowRefSlice(pool, 4, 4);
    const sharedDistant = row0.filter((x) => rowDistant.includes(x)).length;
    expect(sharedDistant).toBeLessThan(2);
  });

  it('wraps around the pool when row index exceeds pool length', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const wrapped = pickPerRowRefSlice(pool, 12, 4); // start = 24 % 12 = 0
    expect(wrapped).toEqual(pickPerRowRefSlice(pool, 0, 4));
  });

  it('falls back to head-of-pool on a negative index', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(pickPerRowRefSlice(pool, -1, 4)).toEqual(pool.slice(0, 4));
  });
});
