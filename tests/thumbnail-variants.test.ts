import { describe, expect, it } from 'vitest';
import {
  buildVariant,
  clampVariantCount,
  DEFAULT_VARIANT_COUNT,
  getSelectedVariantUrl,
  MAX_VARIANT_COUNT,
  MIN_VARIANT_COUNT,
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
