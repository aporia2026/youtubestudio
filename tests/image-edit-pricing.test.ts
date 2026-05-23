import { describe, expect, it } from 'vitest';
import {
  EDIT_OPTIONS,
  DEFAULT_EDIT_OPTION_ID,
  DEFAULT_ERASE_OPTION_ID,
  ERASE_PROMPT,
  formatEditOptionLabel,
  getEditOption,
  getSortedEditOptions,
} from '@/lib/image-edit-pricing';

describe('image edit catalog', () => {
  it('has unique ids', () => {
    const ids = EDIT_OPTIONS.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has at least one mask-capable option for the brush flow', () => {
    expect(EDIT_OPTIONS.some(o => o.maskCapable)).toBe(true);
  });

  it('default edit option resolves and is in the catalog', () => {
    const opt = getEditOption(DEFAULT_EDIT_OPTION_ID);
    expect(opt).toBeDefined();
    expect(opt!.id).toBe(DEFAULT_EDIT_OPTION_ID);
  });

  it('default erase option is mask-capable', () => {
    const opt = getEditOption(DEFAULT_ERASE_OPTION_ID);
    expect(opt).toBeDefined();
    expect(opt!.maskCapable).toBe(true);
  });

  it('erase prompt is non-empty and mentions background reconstruction', () => {
    expect(ERASE_PROMPT.length).toBeGreaterThan(40);
    expect(ERASE_PROMPT.toLowerCase()).toContain('background');
  });

  it('returns undefined for an unknown id', () => {
    expect(getEditOption('not-a-real-id')).toBeUndefined();
  });
});

describe('getSortedEditOptions', () => {
  it('sorts known prices ascending, unknown alphabetical at the end', () => {
    const sorted = getSortedEditOptions();
    const known = sorted.filter(o => o.pricePerImage !== null);
    const unknown = sorted.filter(o => o.pricePerImage === null);
    expect(sorted).toEqual([...known, ...unknown]);

    for (let i = 1; i < known.length; i++) {
      expect(known[i].pricePerImage! >= known[i - 1].pricePerImage!).toBe(true);
    }
    for (let i = 1; i < unknown.length; i++) {
      expect(unknown[i].label.localeCompare(unknown[i - 1].label) >= 0).toBe(true);
    }
  });

  it('contains every catalog entry exactly once', () => {
    const sorted = getSortedEditOptions();
    expect(sorted.length).toBe(EDIT_OPTIONS.length);
    for (const opt of EDIT_OPTIONS) {
      expect(sorted.some(s => s.id === opt.id)).toBe(true);
    }
  });
});

describe('formatEditOptionLabel', () => {
  it('formats known per-image prices', () => {
    const opt = getEditOption('nano-banana-edit')!;
    expect(formatEditOptionLabel(opt)).toBe('Nano Banana — $0.02');
  });

  it('formats per-megapixel prices', () => {
    const opt = getEditOption('qwen-image-edit')!;
    expect(formatEditOptionLabel(opt)).toBe('Qwen Image — $0.03/MP');
  });

  it('formats sub-cent prices to 4 decimals', () => {
    const opt = getEditOption('ideogram-v3-turbo')!;
    expect(formatEditOptionLabel(opt)).toBe('Ideogram v3 Turbo — $0.0175');
  });

  it('hides the price for unverified rows', () => {
    const opt = getEditOption('flux-kontext-pro')!;
    expect(formatEditOptionLabel(opt)).toBe('Flux Kontext Pro — see kie.ai');
  });
});

describe('catalog backends', () => {
  it('every mask-capable kie-standard option uses an Ideogram model', () => {
    // The only kie-standard backend that accepts a mask is Ideogram
    // v3-edit. Anything else flagged maskCapable + kie-standard would
    // be a bug in the catalog.
    for (const opt of EDIT_OPTIONS) {
      if (opt.maskCapable && opt.backend.kind === 'kie-standard') {
        expect(opt.backend.kieModel).toBe('ideogram/v3-edit');
      }
    }
  });

  it('every gpt-4o option declares its quality tier', () => {
    for (const opt of EDIT_OPTIONS) {
      if (opt.backend.kind === 'kie-gpt4o') {
        expect(['low', 'medium', 'high']).toContain(opt.backend.quality);
      }
    }
  });

  it('flux-kontext options use the documented model ids', () => {
    for (const opt of EDIT_OPTIONS) {
      if (opt.backend.kind === 'flux-kontext') {
        expect(['flux-kontext-pro', 'flux-kontext-max']).toContain(opt.backend.kieModel);
      }
    }
  });
});
