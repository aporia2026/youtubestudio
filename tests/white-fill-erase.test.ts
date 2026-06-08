/**
 * Tests for the pure white-fill compositing helper.
 *
 * The canvas-bound layer in `src/lib/editor/white-fill-erase.ts` is
 * thin and browser-only — its image loading + R2 upload pieces don't
 * unit-test cleanly. The pixel logic that decides what to paint white
 * lives in `compositeWhiteFill` and is fully testable here.
 */

import { describe, expect, it } from 'vitest';
import { compositeWhiteFill } from '@/lib/editor/white-fill-erase';

function rgba(r: number, g: number, b: number, a: number): [number, number, number, number] {
  return [r, g, b, a];
}

function buildPixels(pixels: ReadonlyArray<readonly [number, number, number, number]>): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a] = pixels[i];
    arr[i * 4] = r;
    arr[i * 4 + 1] = g;
    arr[i * 4 + 2] = b;
    arr[i * 4 + 3] = a;
  }
  return arr;
}

describe('compositeWhiteFill', () => {
  it('paints opaque white over pixels under a pure-black mask pixel', () => {
    const src = buildPixels([rgba(120, 80, 200, 255)]);
    const mask = buildPixels([rgba(0, 0, 0, 255)]);
    const out = compositeWhiteFill(src, mask);
    expect(Array.from(out)).toEqual([255, 255, 255, 255]);
  });

  it('preserves the source pixel under a pure-white mask pixel', () => {
    const src = buildPixels([rgba(120, 80, 200, 255)]);
    const mask = buildPixels([rgba(255, 255, 255, 255)]);
    const out = compositeWhiteFill(src, mask);
    expect(Array.from(out)).toEqual([120, 80, 200, 255]);
  });

  it('treats near-black mask pixels (≤ threshold) as black', () => {
    // The mask builder emits pure 0 for painted areas, but rare
    // PNG re-encoding can introduce single-digit noise. The
    // implementation uses a small tolerance.
    const src = buildPixels([rgba(50, 50, 50, 255)]);
    const mask = buildPixels([rgba(7, 5, 3, 255)]);
    const out = compositeWhiteFill(src, mask);
    expect(Array.from(out)).toEqual([255, 255, 255, 255]);
  });

  it('treats mid-grey mask pixels (above threshold) as preserve', () => {
    const src = buildPixels([rgba(50, 50, 50, 255)]);
    const mask = buildPixels([rgba(128, 128, 128, 255)]);
    const out = compositeWhiteFill(src, mask);
    expect(Array.from(out)).toEqual([50, 50, 50, 255]);
  });

  it('processes a multi-pixel buffer correctly', () => {
    const src = buildPixels([
      rgba(10, 20, 30, 255),  // black mask → white
      rgba(40, 50, 60, 255),  // white mask → preserve
      rgba(70, 80, 90, 255),  // black mask → white
      rgba(100, 110, 120, 200), // white mask → preserve alpha 200
    ]);
    const mask = buildPixels([
      rgba(0, 0, 0, 255),
      rgba(255, 255, 255, 255),
      rgba(0, 0, 0, 255),
      rgba(255, 255, 255, 255),
    ]);
    const out = compositeWhiteFill(src, mask);
    expect(Array.from(out)).toEqual([
      255, 255, 255, 255,
      40, 50, 60, 255,
      255, 255, 255, 255,
      100, 110, 120, 200,
    ]);
  });

  it('returns a NEW array (does not mutate inputs)', () => {
    const src = buildPixels([rgba(100, 100, 100, 255)]);
    const mask = buildPixels([rgba(0, 0, 0, 255)]);
    const srcCopy = new Uint8ClampedArray(src);
    const maskCopy = new Uint8ClampedArray(mask);
    const out = compositeWhiteFill(src, mask);
    expect(out).not.toBe(src);
    expect(out).not.toBe(mask);
    expect(src).toEqual(srcCopy);
    expect(mask).toEqual(maskCopy);
  });

  it('throws when src and mask byte lengths differ', () => {
    const src = buildPixels([rgba(0, 0, 0, 0)]);
    const mask = buildPixels([rgba(0, 0, 0, 0), rgba(0, 0, 0, 0)]);
    expect(() => compositeWhiteFill(src, mask)).toThrow(/byte-length mismatch/);
  });

  it('throws when src length is not a multiple of 4 (corrupt input guard)', () => {
    const src = new Uint8ClampedArray(7); // not RGBA-aligned
    const mask = new Uint8ClampedArray(7);
    expect(() => compositeWhiteFill(src, mask)).toThrow(/multiple of 4/);
  });

  it('preserves alpha when paint is preserved', () => {
    // A partially-transparent doodle area shouldn't be promoted to
    // opaque by the preserve branch.
    const src = buildPixels([rgba(200, 100, 50, 128)]);
    const mask = buildPixels([rgba(255, 255, 255, 255)]);
    const out = compositeWhiteFill(src, mask);
    expect(out[3]).toBe(128);
  });
});
