import { describe, expect, it } from 'vitest';
import {
  CONTENT_MEDIA,
  DEFAULT_MEDIUM,
  MEDIUM_DISPLAY,
  TOGGLE_SECTIONS,
  getMediumStrategy,
  parseMediumParam,
  type ContentMedium,
  type ToggleSection,
} from '@/lib/content-medium';

describe('parseMediumParam', () => {
  it('returns the default for null / undefined / empty', () => {
    expect(parseMediumParam(null)).toBe(DEFAULT_MEDIUM);
    expect(parseMediumParam(undefined)).toBe(DEFAULT_MEDIUM);
    expect(parseMediumParam('')).toBe(DEFAULT_MEDIUM);
  });

  it('returns the default for unknown values', () => {
    expect(parseMediumParam('shorts')).toBe(DEFAULT_MEDIUM);
    expect(parseMediumParam('long')).toBe(DEFAULT_MEDIUM);
    expect(parseMediumParam('SHORT_NATIVE')).toBe(DEFAULT_MEDIUM); // case-sensitive
    expect(parseMediumParam('null')).toBe(DEFAULT_MEDIUM);
  });

  it('passes through every declared ContentMedium', () => {
    for (const m of CONTENT_MEDIA) {
      expect(parseMediumParam(m)).toBe(m);
    }
  });
});

describe('getMediumStrategy', () => {
  it('returns a strategy whose id matches the requested medium', () => {
    for (const m of CONTENT_MEDIA) {
      expect(getMediumStrategy(m).id).toBe(m);
    }
  });

  it('falls back to long_form on unknown input', () => {
    expect(getMediumStrategy('garbage').id).toBe('long_form');
    expect(getMediumStrategy('').id).toBe('long_form');
    expect(getMediumStrategy(null).id).toBe('long_form');
    expect(getMediumStrategy(undefined).id).toBe('long_form');
  });
});

describe('strategy.forSection contract', () => {
  it('every (medium, section) pair returns a complete MediumSectionAnswer', () => {
    for (const m of CONTENT_MEDIA) {
      const s = getMediumStrategy(m);
      for (const section of TOGGLE_SECTIONS) {
        const ans = s.forSection(section);
        expect(ans.headerHint, `${m}/${section} headerHint`).toBeTruthy();
        expect(typeof ans.available).toBe('boolean');
        // Empty hint may be '' for available=true paths.
        expect(typeof ans.unavailableHint).toBe('string');
      }
    }
  });

  it('headerHint stays inside its layout budget (<= 200 chars)', () => {
    for (const m of CONTENT_MEDIA) {
      const s = getMediumStrategy(m);
      for (const section of TOGGLE_SECTIONS) {
        const ans = s.forSection(section);
        expect(ans.headerHint.length, `${m}/${section} headerHint length`).toBeLessThanOrEqual(200);
      }
    }
  });

  it('long_form is available in every section', () => {
    const s = getMediumStrategy('long_form');
    for (const section of TOGGLE_SECTIONS) {
      expect(s.forSection(section).available, section).toBe(true);
    }
  });

  it('short_clip is available in Ideas + Scripts; not applicable for QA + SEO', () => {
    const s = getMediumStrategy('short_clip');
    expect(s.forSection('ideas').available).toBe(true);
    expect(s.forSection('scripts').available).toBe(true);
    // Clips are recommendations to cut in YT Studio — QA + SEO apply to
    // Shorts you create from scratch, not pointers into someone else's edit.
    expect(s.forSection('qa').available).toBe(false);
    expect(s.forSection('seo').available).toBe(false);
  });

  it('short_native is available in every section (Phase 15.2)', () => {
    const s = getMediumStrategy('short_native');
    for (const section of TOGGLE_SECTIONS) {
      expect(s.forSection(section).available, section).toBe(true);
    }
  });
});

describe('MEDIUM_DISPLAY metadata', () => {
  it('has an entry for every ContentMedium', () => {
    for (const m of CONTENT_MEDIA) {
      const display = MEDIUM_DISPLAY[m];
      expect(display.id).toBe(m);
      expect(display.label).toBeTruthy();
      expect(display.shortLabel).toBeTruthy();
      expect(display.description).toBeTruthy();
    }
  });

  it('shortLabel stays compact for chip layout (<= 12 chars)', () => {
    for (const m of CONTENT_MEDIA) {
      expect(MEDIUM_DISPLAY[m].shortLabel.length, m).toBeLessThanOrEqual(12);
    }
  });

  it('is frozen so callers cannot mutate the registry', () => {
    expect(() => {
      // @ts-expect-error — runtime mutation test
      MEDIUM_DISPLAY.long_form = { id: 'long_form', label: 'x', shortLabel: 'x', description: 'x' };
    }).toThrow();
  });
});

describe('exports — type-level safety', () => {
  it('CONTENT_MEDIA contains exactly the three expected values', () => {
    expect([...CONTENT_MEDIA].sort()).toEqual(['long_form', 'short_clip', 'short_native'].sort());
  });

  it('TOGGLE_SECTIONS contains exactly the four expected sections', () => {
    expect([...TOGGLE_SECTIONS].sort()).toEqual(['ideas', 'qa', 'scripts', 'seo'].sort());
  });

  it('type-level: ContentMedium and ToggleSection are usable as discriminators', () => {
    // Compile-time check disguised as runtime — if these don't compile,
    // the test file fails to load.
    const m: ContentMedium = 'long_form';
    const s: ToggleSection = 'ideas';
    expect(m).toBe('long_form');
    expect(s).toBe('ideas');
  });
});
