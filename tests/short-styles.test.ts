import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_STYLE_ID,
  SHORT_STYLE_IDS,
  getShortStyle,
  listAvailableShortStyles,
  listShortStyles,
} from '@/lib/short-styles';

describe('getShortStyle', () => {
  it('returns the default on null / undefined / empty', () => {
    expect(getShortStyle(null).id).toBe(DEFAULT_SHORT_STYLE_ID);
    expect(getShortStyle(undefined).id).toBe(DEFAULT_SHORT_STYLE_ID);
    expect(getShortStyle('').id).toBe(DEFAULT_SHORT_STYLE_ID);
  });

  it('returns the matching entry for every registered id', () => {
    for (const id of SHORT_STYLE_IDS) {
      expect(getShortStyle(id).id).toBe(id);
    }
  });

  it('returns the default for unknown ids (no throw)', () => {
    expect(getShortStyle('paint_v99').id).toBe(DEFAULT_SHORT_STYLE_ID);
    expect(getShortStyle('garbage').id).toBe(DEFAULT_SHORT_STYLE_ID);
  });
});

describe('listShortStyles / listAvailableShortStyles', () => {
  it('lists every registered style in registry order', () => {
    const ids = listShortStyles().map((s) => s.id);
    expect(ids).toEqual([...SHORT_STYLE_IDS]);
  });

  it('listAvailableShortStyles is a subset of listShortStyles', () => {
    const avail = listAvailableShortStyles().map((s) => s.id);
    const all = new Set(listShortStyles().map((s) => s.id));
    for (const id of avail) {
      expect(all.has(id)).toBe(true);
    }
  });

  it('Phase 15.2 has exactly one available style (minimal_gradient_v1)', () => {
    const avail = listAvailableShortStyles();
    expect(avail.length).toBe(1);
    expect(avail[0]!.id).toBe('minimal_gradient_v1');
  });

  it('every non-available style declares a comingPhase', () => {
    for (const s of listShortStyles()) {
      if (!s.available) {
        expect(s.comingPhase, `${s.id} missing comingPhase`).toBeTruthy();
      }
    }
  });
});

describe('registry shape', () => {
  it('every entry has the required fields filled', () => {
    for (const s of listShortStyles()) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(typeof s.available).toBe('boolean');
      expect(['minimal', 'light', 'heavy']).toContain(s.costBand);
    }
  });

  it('labels stay within picker layout budget (<= 28 chars)', () => {
    for (const s of listShortStyles()) {
      expect(s.label.length, s.id).toBeLessThanOrEqual(28);
    }
  });

  it('descriptions stay within hover/tooltip budget (<= 200 chars)', () => {
    for (const s of listShortStyles()) {
      expect(s.description.length, s.id).toBeLessThanOrEqual(200);
    }
  });
});
