import { describe, expect, it } from 'vitest';
import {
  SHORTS_SETTINGS_DEFAULTS,
  normalizeShortsSettings,
} from '@/lib/shorts-workspace-settings';

/**
 * getShortsSettings + updateShortsSettings hit the DB and are exercised
 * via integration paths. The pure `normalizeShortsSettings` is where
 * all the defensive parsing lives — that's what these tests cover.
 */

describe('normalizeShortsSettings — empty / garbage input', () => {
  it('returns full defaults for null', () => {
    expect(normalizeShortsSettings(null)).toEqual(SHORTS_SETTINGS_DEFAULTS);
  });

  it('returns full defaults for undefined', () => {
    expect(normalizeShortsSettings(undefined)).toEqual(SHORTS_SETTINGS_DEFAULTS);
  });

  it('returns full defaults for an empty object', () => {
    expect(normalizeShortsSettings({})).toEqual(SHORTS_SETTINGS_DEFAULTS);
  });

  it('returns full defaults for a number / string / array', () => {
    expect(normalizeShortsSettings(42)).toEqual(SHORTS_SETTINGS_DEFAULTS);
    expect(normalizeShortsSettings('garbage')).toEqual(SHORTS_SETTINGS_DEFAULTS);
    expect(normalizeShortsSettings(['a', 'b'])).toEqual(SHORTS_SETTINGS_DEFAULTS);
  });

  it('skips fields with wrong types', () => {
    expect(
      normalizeShortsSettings({
        autoFanOutEnabled: 'yes',          // wrong type → default
        autoFanOutCount: '3',              // wrong type → default
        hookScoreThreshold: 'high',        // wrong type → default
      }),
    ).toEqual(SHORTS_SETTINGS_DEFAULTS);
  });
});

describe('normalizeShortsSettings — clamping', () => {
  it('clamps autoFanOutCount into [0, 5]', () => {
    expect(normalizeShortsSettings({ autoFanOutCount: -1 }).autoFanOutCount).toBe(0);
    expect(normalizeShortsSettings({ autoFanOutCount: 0 }).autoFanOutCount).toBe(0);
    expect(normalizeShortsSettings({ autoFanOutCount: 3 }).autoFanOutCount).toBe(3);
    expect(normalizeShortsSettings({ autoFanOutCount: 100 }).autoFanOutCount).toBe(5);
  });

  it('rounds non-integer autoFanOutCount', () => {
    expect(normalizeShortsSettings({ autoFanOutCount: 2.7 }).autoFanOutCount).toBe(3);
  });

  it('rejects non-finite autoFanOutCount (NaN / Infinity)', () => {
    expect(normalizeShortsSettings({ autoFanOutCount: NaN }).autoFanOutCount).toBe(
      SHORTS_SETTINGS_DEFAULTS.autoFanOutCount,
    );
    expect(normalizeShortsSettings({ autoFanOutCount: Infinity }).autoFanOutCount).toBe(
      SHORTS_SETTINGS_DEFAULTS.autoFanOutCount,
    );
  });

  it('clamps defaultTargetSecondsModeA into [15, 90]', () => {
    expect(normalizeShortsSettings({ defaultTargetSecondsModeA: 5 }).defaultTargetSecondsModeA).toBe(15);
    expect(normalizeShortsSettings({ defaultTargetSecondsModeA: 200 }).defaultTargetSecondsModeA).toBe(90);
    expect(normalizeShortsSettings({ defaultTargetSecondsModeA: 45 }).defaultTargetSecondsModeA).toBe(45);
  });

  it('clamps hookScoreThreshold into [0, 1]', () => {
    expect(normalizeShortsSettings({ hookScoreThreshold: -0.5 }).hookScoreThreshold).toBe(0);
    expect(normalizeShortsSettings({ hookScoreThreshold: 1.5 }).hookScoreThreshold).toBe(1);
    expect(normalizeShortsSettings({ hookScoreThreshold: 0.6 }).hookScoreThreshold).toBe(0.6);
  });
});

describe('normalizeShortsSettings — sectionDefaultMedium enum', () => {
  it('accepts every valid value', () => {
    for (const v of ['long_form', 'short_native', 'remember_last']) {
      expect(
        normalizeShortsSettings({ sectionDefaultMedium: v }).sectionDefaultMedium,
      ).toBe(v);
    }
  });

  it('falls back to default for unknown values', () => {
    expect(
      normalizeShortsSettings({ sectionDefaultMedium: 'short_clip' }).sectionDefaultMedium,
    ).toBe(SHORTS_SETTINGS_DEFAULTS.sectionDefaultMedium);
    expect(
      normalizeShortsSettings({ sectionDefaultMedium: 'garbage' }).sectionDefaultMedium,
    ).toBe(SHORTS_SETTINGS_DEFAULTS.sectionDefaultMedium);
  });
});

describe('SHORTS_SETTINGS_DEFAULTS', () => {
  it('is frozen so callers cannot mutate the shared singleton', () => {
    expect(() => {
      // @ts-expect-error — runtime mutation test
      SHORTS_SETTINGS_DEFAULTS.autoFanOutEnabled = false;
    }).toThrow();
  });

  it('matches the documented defaults from the plan §7', () => {
    expect(SHORTS_SETTINGS_DEFAULTS).toEqual({
      autoFanOutEnabled: true,
      autoFanOutCount: 3,
      defaultTargetSecondsModeA: 45,
      hookScoreThreshold: 0.6,
      sectionDefaultMedium: 'remember_last',
    });
  });
});

describe('normalizeShortsSettings — partial patch over current row', () => {
  it('preserves unspecified fields when patching one key', () => {
    const result = normalizeShortsSettings({ autoFanOutEnabled: false });
    expect(result.autoFanOutEnabled).toBe(false);
    expect(result.autoFanOutCount).toBe(SHORTS_SETTINGS_DEFAULTS.autoFanOutCount);
    expect(result.defaultTargetSecondsModeA).toBe(
      SHORTS_SETTINGS_DEFAULTS.defaultTargetSecondsModeA,
    );
  });
});
