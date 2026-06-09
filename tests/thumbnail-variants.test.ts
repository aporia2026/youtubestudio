import { describe, expect, it } from 'vitest';
import {
  buildVariant,
  clampVariantCount,
  DEFAULT_VARIANT_COUNT,
  getSelectedVariantUrl,
  MAX_VARIANT_COUNT,
  MIN_VARIANT_COUNT,
  variantsFingerprint,
  type ThumbnailVariant,
  type VariantBearingPayload,
} from '@/lib/thumbnail-variants';

describe('clampVariantCount', () => {
  it('returns the default for undefined / null / non-finite input', () => {
    expect(clampVariantCount(undefined)).toBe(DEFAULT_VARIANT_COUNT);
    expect(clampVariantCount(null)).toBe(DEFAULT_VARIANT_COUNT);
    expect(clampVariantCount(NaN)).toBe(DEFAULT_VARIANT_COUNT);
    expect(clampVariantCount(Infinity)).toBe(DEFAULT_VARIANT_COUNT);
  });

  it('clamps below MIN_VARIANT_COUNT up to the floor', () => {
    expect(clampVariantCount(0)).toBe(MIN_VARIANT_COUNT);
    expect(clampVariantCount(-5)).toBe(MIN_VARIANT_COUNT);
  });

  it('clamps above MAX_VARIANT_COUNT down to the ceiling', () => {
    expect(clampVariantCount(MAX_VARIANT_COUNT + 1)).toBe(MAX_VARIANT_COUNT);
    expect(clampVariantCount(99)).toBe(MAX_VARIANT_COUNT);
  });

  it('passes integers in range through', () => {
    for (let n = MIN_VARIANT_COUNT; n <= MAX_VARIANT_COUNT; n += 1) {
      expect(clampVariantCount(n)).toBe(n);
    }
  });

  it('floors fractional input', () => {
    expect(clampVariantCount(2.9)).toBe(2);
    expect(clampVariantCount(1.4)).toBe(1);
  });
});

describe('buildVariant', () => {
  it('stamps a stable id of the form v{index}', () => {
    expect(buildVariant({ index: 0, imageUrl: 'https://x/0.png', promptUsed: 'p' }).id).toBe('v0');
    expect(buildVariant({ index: 2, imageUrl: 'https://x/2.png', promptUsed: 'p' }).id).toBe('v2');
  });

  it('carries the prompt and concept label verbatim', () => {
    const v = buildVariant({
      index: 1,
      imageUrl: 'https://x/1.png',
      promptUsed: 'hello world',
      conceptLabel: 'left composition',
      costEstimateUsd: 0.02,
    });
    expect(v.promptUsed).toBe('hello world');
    expect(v.conceptLabel).toBe('left composition');
    expect(v.costEstimateUsd).toBe(0.02);
  });

  it('stamps completedAt as a positive number', () => {
    const v = buildVariant({ index: 0, imageUrl: 'https://x/0.png', promptUsed: 'p' });
    expect(typeof v.completedAt).toBe('number');
    expect(v.completedAt!).toBeGreaterThan(0);
  });
});

describe('getSelectedVariantUrl', () => {
  function makeVariant(id: string, imageUrl: string): ThumbnailVariant {
    return { id, imageUrl, promptUsed: 'p' };
  }

  it('returns empty string for null / undefined payload', () => {
    expect(getSelectedVariantUrl(null)).toBe('');
    expect(getSelectedVariantUrl(undefined)).toBe('');
  });

  it('returns the selected variant url when set', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', 'https://x/0.png'),
        makeVariant('v1', 'https://x/1.png'),
        makeVariant('v2', 'https://x/2.png'),
      ],
      selectedVariantIndex: 1,
    };
    expect(getSelectedVariantUrl(payload)).toBe('https://x/1.png');
  });

  it('defaults to the first variant when selectedVariantIndex is missing', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', 'https://x/0.png'),
        makeVariant('v1', 'https://x/1.png'),
      ],
    };
    expect(getSelectedVariantUrl(payload)).toBe('https://x/0.png');
  });

  it('clamps an out-of-range selectedVariantIndex into the valid range', () => {
    const payload: VariantBearingPayload = {
      variants: [makeVariant('v0', 'https://x/0.png'), makeVariant('v1', 'https://x/1.png')],
      selectedVariantIndex: 99,
    };
    expect(getSelectedVariantUrl(payload)).toBe('https://x/1.png');
  });

  it('falls back to the first non-empty variant when the selected slot is empty', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', ''),
        makeVariant('v1', 'https://x/1.png'),
        makeVariant('v2', 'https://x/2.png'),
      ],
      selectedVariantIndex: 0,
    };
    expect(getSelectedVariantUrl(payload)).toBe('https://x/1.png');
  });

  it('falls back to legacy imageUrl when variants is empty / undefined', () => {
    expect(getSelectedVariantUrl({ imageUrl: 'https://legacy.png' })).toBe('https://legacy.png');
    expect(getSelectedVariantUrl({ variants: [], imageUrl: 'https://legacy.png' })).toBe('https://legacy.png');
  });

  it('returns empty string when nothing is usable', () => {
    expect(getSelectedVariantUrl({})).toBe('');
    expect(getSelectedVariantUrl({ variants: [] })).toBe('');
    expect(getSelectedVariantUrl({ variants: [makeVariant('v0', '')] })).toBe('');
  });
});

describe('variantsFingerprint', () => {
  // The bug we're guarding against: a failed variant 0 (imageUrl '')
  // used as fingerprint would collide every variant-0-failed generation
  // into the same empty-string bucket, silently merging distinct
  // history entries. The helper MUST pick the first non-empty variant
  // URL to avoid this.

  function makeVariant(id: string, imageUrl: string): ThumbnailVariant {
    return { id, imageUrl, promptUsed: 'p' };
  }

  it('returns empty string for null / undefined / empty payload', () => {
    expect(variantsFingerprint(null)).toBe('');
    expect(variantsFingerprint(undefined)).toBe('');
    expect(variantsFingerprint({})).toBe('');
  });

  it('returns the first non-empty variant URL', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', 'https://x/0.png'),
        makeVariant('v1', 'https://x/1.png'),
        makeVariant('v2', 'https://x/2.png'),
      ],
    };
    expect(variantsFingerprint(payload)).toBe('https://x/0.png');
  });

  it('REGRESSION GUARD: skips a failed variant 0 and picks variant 1 (the bug)', () => {
    // This is the specific bug `variants?.[0]?.imageUrl ?? imageUrl`
    // suffered from: empty string is not nullish, so ?? doesn't fire.
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', ''),                     // failed
        makeVariant('v1', 'https://x/1.png'),      // succeeded
        makeVariant('v2', 'https://x/2.png'),
      ],
      imageUrl: 'https://legacy-fallback.png',
    };
    // Must NOT be '' (the bug) and must NOT be the legacy fallback
    // (variants exist, the right answer is the first good one).
    expect(variantsFingerprint(payload)).toBe('https://x/1.png');
  });

  it('REGRESSION GUARD: skips multiple consecutive failed variants', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', ''),
        makeVariant('v1', ''),
        makeVariant('v2', 'https://x/2.png'),
      ],
    };
    expect(variantsFingerprint(payload)).toBe('https://x/2.png');
  });

  it('falls back to legacy imageUrl when all variants empty', () => {
    const payload: VariantBearingPayload = {
      variants: [
        makeVariant('v0', ''),
        makeVariant('v1', ''),
        makeVariant('v2', ''),
      ],
      imageUrl: 'https://legacy.png',
    };
    expect(variantsFingerprint(payload)).toBe('https://legacy.png');
  });

  it('falls back to legacy imageUrl when variants is empty array', () => {
    expect(variantsFingerprint({ variants: [], imageUrl: 'https://legacy.png' })).toBe('https://legacy.png');
  });

  it('falls back to legacy imageUrl when variants is undefined (old entries)', () => {
    expect(variantsFingerprint({ imageUrl: 'https://legacy.png' })).toBe('https://legacy.png');
  });

  it('returns empty string when nothing usable', () => {
    expect(variantsFingerprint({ variants: [makeVariant('v0', '')], imageUrl: '' })).toBe('');
    expect(variantsFingerprint({ variants: [makeVariant('v0', '')] })).toBe('');
  });

  it('is selection-index-independent (stable across variant picks)', () => {
    // This is the property that makes it work as a "generation key":
    // picking a different variant doesn't change the fingerprint.
    const variants = [
      makeVariant('v0', 'https://x/0.png'),
      makeVariant('v1', 'https://x/1.png'),
      makeVariant('v2', 'https://x/2.png'),
    ];
    const fp0 = variantsFingerprint({ variants, selectedVariantIndex: 0, imageUrl: 'https://x/0.png' });
    const fp1 = variantsFingerprint({ variants, selectedVariantIndex: 1, imageUrl: 'https://x/1.png' });
    const fp2 = variantsFingerprint({ variants, selectedVariantIndex: 2, imageUrl: 'https://x/2.png' });
    expect(fp0).toBe(fp1);
    expect(fp1).toBe(fp2);
  });
});
