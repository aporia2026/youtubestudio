import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fanOutFormatImageRoute,
  perturbPalette,
  rotateHexHue,
} from '@/lib/thumbnail-variants-client';

describe('rotateHexHue', () => {
  it('returns the input unchanged for a 0° rotation', () => {
    expect(rotateHexHue('#ff0000', 0)).toBe('#ff0000');
    expect(rotateHexHue('#00ff00', 0)).toBe('#00ff00');
  });

  it('rotates 180° from pure red to cyan', () => {
    // Red (#ff0000) at hue 0 → cyan (#00ffff) at hue 180. HSL math
    // round-trip introduces ±1 quantization; allow approximate match.
    const result = rotateHexHue('#ff0000', 180).toLowerCase();
    // Expect cyan-ish: high G + high B, low R.
    const r = parseInt(result.slice(1, 3), 16);
    const g = parseInt(result.slice(3, 5), 16);
    const b = parseInt(result.slice(5, 7), 16);
    expect(r).toBeLessThan(10);
    expect(g).toBeGreaterThan(245);
    expect(b).toBeGreaterThan(245);
  });

  it('rotates 90° from red to chartreuse/yellow-green', () => {
    const result = rotateHexHue('#ff0000', 90);
    const r = parseInt(result.slice(1, 3), 16);
    const g = parseInt(result.slice(3, 5), 16);
    expect(g).toBeGreaterThan(r); // green dominant
  });

  it('handles missing leading hash', () => {
    expect(rotateHexHue('ff0000', 0)).toBe('#ff0000');
  });

  it('rotates wraparound correctly (360° = identity)', () => {
    const out = rotateHexHue('#1234ab', 360).toLowerCase();
    expect(out).toBe('#1234ab');
  });

  it('handles negative rotations (wrap to positive)', () => {
    const a = rotateHexHue('#ff0000', -90).toLowerCase();
    const b = rotateHexHue('#ff0000', 270).toLowerCase();
    expect(a).toBe(b);
  });

  it('returns the input unchanged for malformed hex (defensive)', () => {
    expect(rotateHexHue('not-a-hex', 90)).toBe('not-a-hex');
    expect(rotateHexHue('#xyz', 90)).toBe('#xyz');
    expect(rotateHexHue('', 90)).toBe('');
  });

  it('preserves grayscale tones across rotation (saturation 0)', () => {
    // Grayscale colors should stay grayscale regardless of hue rotation
    // because their HSL saturation is 0.
    const out = rotateHexHue('#808080', 180).toLowerCase();
    const r = parseInt(out.slice(1, 3), 16);
    const g = parseInt(out.slice(3, 5), 16);
    const b = parseInt(out.slice(5, 7), 16);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });
});

describe('perturbPalette', () => {
  const base = {
    background: '#1a1a2e',
    primary_accent: '#e94560',
    secondary_accent: '#f7d716',
  };

  it('returns the original palette at index 0', () => {
    expect(perturbPalette(base, 0)).toEqual(base);
  });

  it('swaps primary ↔ secondary at index 1', () => {
    const out = perturbPalette(base, 1);
    expect(out.background).toBe(base.background);
    expect(out.primary_accent).toBe(base.secondary_accent);
    expect(out.secondary_accent).toBe(base.primary_accent);
  });

  it('rotates every color 180° at index 2', () => {
    const out = perturbPalette(base, 2);
    expect(out.background).not.toBe(base.background);
    expect(out.primary_accent).not.toBe(base.primary_accent);
    expect(out.secondary_accent).not.toBe(base.secondary_accent);
    // 180° rotation should be the complement of each
    expect(out.background).toBe(rotateHexHue(base.background, 180));
    expect(out.primary_accent).toBe(rotateHexHue(base.primary_accent, 180));
    expect(out.secondary_accent).toBe(rotateHexHue(base.secondary_accent, 180));
  });

  it('returns the original palette for out-of-range indexes (defensive)', () => {
    expect(perturbPalette(base, 3)).toEqual(base);
    expect(perturbPalette(base, 99)).toEqual(base);
    expect(perturbPalette(base, -1)).toEqual(base);
  });

  it('produces 3 distinct outputs for indexes 0/1/2 (the variant axis)', () => {
    const v0 = perturbPalette(base, 0);
    const v1 = perturbPalette(base, 1);
    const v2 = perturbPalette(base, 2);
    const fingerprint = (p: { background: string; primary_accent: string; secondary_accent: string }) =>
      `${p.background}|${p.primary_accent}|${p.secondary_accent}`;
    const fps = new Set([fingerprint(v0), fingerprint(v1), fingerprint(v2)]);
    expect(fps.size).toBe(3);
  });

  it('is deterministic — same input + index produces identical output', () => {
    expect(perturbPalette(base, 1)).toEqual(perturbPalette(base, 1));
    expect(perturbPalette(base, 2)).toEqual(perturbPalette(base, 2));
  });
});

describe('fanOutFormatImageRoute — defensive callback handling', () => {
  // The fan-out helper accepts an optional bodyPerVariant callback.
  // If the callback throws OR returns a non-serializable value (BigInt,
  // circular ref), a naive implementation would crash the whole
  // fan-out before any request fires. We expect graceful degradation:
  // the offending variant comes back with imageUrl='' (failed slot),
  // the siblings still complete normally.

  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // Echo the body's marker back as imageUrl so the test can assert
      // which variant fired which body.
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const url = `https://fake/${body.marker ?? 'default'}.png`;
      return new Response(JSON.stringify({ imageUrl: url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fans out N parallel calls when no callback is provided', async () => {
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
    });
    expect(out.variants).toHaveLength(3);
    expect(out.failedCount).toBe(0);
    expect(out.firstSuccess).toEqual({ imageUrl: 'https://fake/base.png' });
    expect(out.variants.every(v => v.imageUrl === 'https://fake/base.png')).toBe(true);
  });

  it('uses bodyPerVariant for each call', async () => {
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
      bodyPerVariant: (idx) => ({ marker: `variant-${idx}` }),
    });
    expect(out.variants.map(v => v.imageUrl)).toEqual([
      'https://fake/variant-0.png',
      'https://fake/variant-1.png',
      'https://fake/variant-2.png',
    ]);
  });

  it('handles a throwing bodyPerVariant for one variant without killing siblings', async () => {
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
      bodyPerVariant: (idx) => {
        if (idx === 1) throw new Error('boom!');
        return { marker: `variant-${idx}` };
      },
    });
    expect(out.variants).toHaveLength(3);
    expect(out.failedCount).toBe(1);
    expect(out.variants[0].imageUrl).toBe('https://fake/variant-0.png');
    expect(out.variants[1].imageUrl).toBe(''); // failed
    expect(out.variants[2].imageUrl).toBe('https://fake/variant-2.png');
  });

  it('handles a bodyPerVariant returning a non-serializable value (BigInt) without killing siblings', async () => {
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
      // BigInt isn't JSON-serializable. Returning one should fail just
      // that variant, not the whole fan-out.
      bodyPerVariant: (idx) => {
        if (idx === 2) return { value: BigInt(42) };
        return { marker: `variant-${idx}` };
      },
    });
    expect(out.failedCount).toBe(1);
    expect(out.variants[2].imageUrl).toBe('');
    expect(out.variants[0].imageUrl).toBe('https://fake/variant-0.png');
    expect(out.variants[1].imageUrl).toBe('https://fake/variant-1.png');
  });

  it('handles a bodyPerVariant returning a circular reference without killing siblings', async () => {
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
      bodyPerVariant: (idx) => {
        if (idx === 0) {
          const obj: Record<string, unknown> = {};
          obj.self = obj; // circular
          return obj;
        }
        return { marker: `variant-${idx}` };
      },
    });
    expect(out.failedCount).toBe(1);
    expect(out.variants[0].imageUrl).toBe('');
    expect(out.variants[1].imageUrl).toBe('https://fake/variant-1.png');
    expect(out.variants[2].imageUrl).toBe('https://fake/variant-2.png');
  });

  it('returns failedCount === variantCount when all fail', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"down"}', { status: 503 }));
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
    });
    expect(out.failedCount).toBe(3);
    expect(out.firstSuccess).toBeNull();
    expect(out.variants.every(v => v.imageUrl === '')).toBe(true);
  });

  it('returns first SUCCESS even when later variants happen to settle first', async () => {
    // Simulate variant 0 being slowest: variant 2 returns instantly,
    // variant 0 takes a tick. firstSuccess should still be the first-by-
    // index successful response, NOT the first-by-time. The current
    // implementation uses `results.find` which is index-order — verify.
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const idx = body.idx ?? 0;
      if (idx === 0) {
        await new Promise(r => setTimeout(r, 10));
      }
      return new Response(JSON.stringify({ imageUrl: `https://fake/idx-${idx}.png` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const out = await fanOutFormatImageRoute<{ imageUrl: string }>({
      routeUrl: '/api/test',
      body: { marker: 'base' },
      variantCount: 3,
      bodyPerVariant: (idx) => ({ idx }),
    });
    // firstSuccess should be the variant at index 0 (first by index),
    // not variant 2 which settled first. Important because the panel
    // uses firstSuccess to populate fields like `regions` and `layout`
    // that should match a canonical variant, not whichever was fastest.
    expect(out.firstSuccess?.imageUrl).toBe('https://fake/idx-0.png');
  });
});
