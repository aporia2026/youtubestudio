/**
 * Tests for the server-side white-fill compositor used by the erase
 * route when the doc's style is one of the white-background sketch
 * presets. Mirrors what the client-side helper used to do, but runs
 * on the server where the canvas + CORS issues that broke the
 * browser implementation don't exist.
 *
 * The network + R2 + sharp wrapper at `eraseViaServerWhiteFill`
 * stays an integration concern. The pure byte-level
 * `compositeWhiteFillBuffers` is fully testable here.
 */

import { describe, expect, it } from 'vitest';
import {
  MASK_BLACK_RGB_THRESHOLD,
  compositeWhiteFillBuffers,
} from '@/lib/erase-white-fill-server';

function rgba(r: number, g: number, b: number, a: number): readonly [number, number, number, number] {
  return [r, g, b, a];
}

function buildBuffer(pixels: ReadonlyArray<readonly [number, number, number, number]>): Buffer {
  const buf = Buffer.alloc(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a] = pixels[i];
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe('compositeWhiteFillBuffers — pixel logic', () => {
  it('paints opaque white over pixels under a pure-black mask pixel', () => {
    const src = buildBuffer([rgba(120, 80, 200, 255)]);
    const mask = buildBuffer([rgba(0, 0, 0, 255)]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(Array.from(out)).toEqual([255, 255, 255, 255]);
  });

  it('preserves the source pixel under a pure-white mask pixel', () => {
    const src = buildBuffer([rgba(120, 80, 200, 255)]);
    const mask = buildBuffer([rgba(255, 255, 255, 255)]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(Array.from(out)).toEqual([120, 80, 200, 255]);
  });

  it('treats near-black mask pixels (≤ threshold) as black', () => {
    const src = buildBuffer([rgba(50, 50, 50, 255)]);
    const mask = buildBuffer([rgba(MASK_BLACK_RGB_THRESHOLD, MASK_BLACK_RGB_THRESHOLD - 1, 0, 255)]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(Array.from(out)).toEqual([255, 255, 255, 255]);
  });

  it('treats mid-grey mask pixels (above threshold) as preserve', () => {
    const src = buildBuffer([rgba(50, 50, 50, 255)]);
    const mask = buildBuffer([rgba(128, 128, 128, 255)]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(Array.from(out)).toEqual([50, 50, 50, 255]);
  });

  it('processes a multi-pixel buffer correctly', () => {
    const src = buildBuffer([
      rgba(10, 20, 30, 255),     // black mask → white
      rgba(40, 50, 60, 255),     // white mask → preserve
      rgba(70, 80, 90, 255),     // black mask → white
      rgba(100, 110, 120, 200),  // white mask → preserve alpha 200
    ]);
    const mask = buildBuffer([
      rgba(0, 0, 0, 255),
      rgba(255, 255, 255, 255),
      rgba(0, 0, 0, 255),
      rgba(255, 255, 255, 255),
    ]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 4,
    });
    expect(Array.from(out)).toEqual([
      255, 255, 255, 255,
      40, 50, 60, 255,
      255, 255, 255, 255,
      100, 110, 120, 200,
    ]);
  });

  it('returns a NEW buffer (does not mutate inputs)', () => {
    const src = buildBuffer([rgba(100, 100, 100, 255)]);
    const mask = buildBuffer([rgba(0, 0, 0, 255)]);
    const srcCopy = Buffer.from(src);
    const maskCopy = Buffer.from(mask);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(out).not.toBe(src);
    expect(out).not.toBe(mask);
    expect(src.equals(srcCopy)).toBe(true);
    expect(mask.equals(maskCopy)).toBe(true);
  });

  it('throws when src length does not match pixelCount × srcChannels', () => {
    const src = buildBuffer([rgba(0, 0, 0, 0), rgba(0, 0, 0, 0)]);
    const mask = buildBuffer([rgba(0, 0, 0, 0)]);
    expect(() => compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    })).toThrow(/src length/);
  });

  it('throws when mask length does not match pixelCount × maskChannels', () => {
    const src = buildBuffer([rgba(0, 0, 0, 0)]);
    const mask = buildBuffer([rgba(0, 0, 0, 0), rgba(0, 0, 0, 0)]);
    expect(() => compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    })).toThrow(/mask length/);
  });

  it('preserves alpha when paint is preserved', () => {
    const src = buildBuffer([rgba(200, 100, 50, 128)]);
    const mask = buildBuffer([rgba(255, 255, 255, 255)]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 4, maskChannels: 4, pixelCount: 1,
    });
    expect(out[3]).toBe(128);
  });

  it('handles 3-channel (no alpha) source correctly', () => {
    // sharp's .raw() can emit RGB without alpha depending on the input
    // PNG. Verify the helper writes only 3 bytes per pixel in that case.
    const src = Buffer.from([100, 150, 200, 50, 60, 70]);
    const mask = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]);
    const out = compositeWhiteFillBuffers({
      srcRgba: src, maskRgba: mask, srcChannels: 3, maskChannels: 4, pixelCount: 2,
    });
    expect(Array.from(out)).toEqual([255, 255, 255, 50, 60, 70]);
  });
});
