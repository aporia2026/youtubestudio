import { describe, expect, it } from 'vitest';
import {
  SHORTS_SERIES_LIMITS,
  normalizeOptionalText,
  validateLockedStyleId,
  validateSeriesName,
} from '@/lib/shorts-series';

describe('validateSeriesName', () => {
  it('returns the trimmed name for valid input', () => {
    expect(validateSeriesName('  Monday Doodle Facts  ')).toBe('Monday Doodle Facts');
  });

  it('rejects non-string input', () => {
    expect(validateSeriesName(undefined)).toBeNull();
    expect(validateSeriesName(null)).toBeNull();
    expect(validateSeriesName(42)).toBeNull();
    expect(validateSeriesName({})).toBeNull();
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(validateSeriesName('')).toBeNull();
    expect(validateSeriesName('   ')).toBeNull();
    expect(validateSeriesName('\n\t')).toBeNull();
  });

  it('rejects names longer than the cap', () => {
    const tooLong = 'a'.repeat(SHORTS_SERIES_LIMITS.MAX_NAME_CHARS + 1);
    expect(validateSeriesName(tooLong)).toBeNull();
  });

  it('accepts names at exactly the cap', () => {
    const atCap = 'a'.repeat(SHORTS_SERIES_LIMITS.MAX_NAME_CHARS);
    expect(validateSeriesName(atCap)).toBe(atCap);
  });
});

describe('validateLockedStyleId', () => {
  it('accepts every registered style id', () => {
    expect(validateLockedStyleId('minimal_gradient_v1')).toBe('minimal_gradient_v1');
    expect(validateLockedStyleId('doodle_explainer_2_short')).toBe('doodle_explainer_2_short');
    expect(validateLockedStyleId('paint_explainer_v1_short')).toBe('paint_explainer_v1_short');
  });

  it('rejects unknown style ids', () => {
    expect(validateLockedStyleId('minimal')).toBeNull();
    expect(validateLockedStyleId('doodle')).toBeNull();
    expect(validateLockedStyleId('garbage')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateLockedStyleId(undefined)).toBeNull();
    expect(validateLockedStyleId(null)).toBeNull();
    expect(validateLockedStyleId(42)).toBeNull();
  });
});

describe('normalizeOptionalText', () => {
  it('returns null for missing / empty input (NULL the column)', () => {
    expect(normalizeOptionalText(undefined, 100)).toBeNull();
    expect(normalizeOptionalText(null, 100)).toBeNull();
    expect(normalizeOptionalText('', 100)).toBeNull();
    expect(normalizeOptionalText('   ', 100)).toBeNull();
  });

  it('returns the trimmed text within cap', () => {
    expect(normalizeOptionalText('  hello  ', 100)).toBe('hello');
  });

  it('slices to the cap (does not throw)', () => {
    const long = 'a'.repeat(300);
    expect(normalizeOptionalText(long, 100)).toBe('a'.repeat(100));
  });

  it('rejects non-string input', () => {
    expect(normalizeOptionalText(42, 100)).toBeNull();
    expect(normalizeOptionalText({}, 100)).toBeNull();
  });
});

describe('SHORTS_SERIES_LIMITS', () => {
  it('exposes the documented caps', () => {
    expect(SHORTS_SERIES_LIMITS.MAX_NAME_CHARS).toBe(80);
    expect(SHORTS_SERIES_LIMITS.MAX_CADENCE_CHARS).toBe(80);
    expect(SHORTS_SERIES_LIMITS.MAX_INTRO_OUTRO_CHARS).toBe(280);
    expect(SHORTS_SERIES_LIMITS.MAX_NOTES_CHARS).toBe(1000);
  });

  it('is frozen so callers cannot mutate the singleton', () => {
    expect(() => {
      // @ts-expect-error — runtime mutation test
      SHORTS_SERIES_LIMITS.MAX_NAME_CHARS = 999;
    }).toThrow();
  });
});
