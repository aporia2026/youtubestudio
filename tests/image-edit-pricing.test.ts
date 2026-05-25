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

describe('Atlas Cloud edit entry', () => {
  it('exposes gpt-image-2-atlas-edit with the atlas backend', () => {
    const opt = getEditOption('gpt-image-2-atlas-edit');
    expect(opt).toBeDefined();
    expect(opt!.backend.kind).toBe('atlas');
    if (opt!.backend.kind === 'atlas') {
      // Currently the only Atlas Edit model; future expansion would
      // widen this assertion. Keeps the literal type contract honest.
      expect(opt!.backend.atlasModel).toBe('openai/gpt-image-2/edit');
    }
  });

  it('Atlas Edit is NOT mask-capable so the eraser flow filters it out', () => {
    // /api/overlay/edit filters by maskCapable. Atlas Edit has no mask
    // param, so this flag MUST stay false — flipping it true would
    // route the eraser through Atlas, which would 400 on every mask
    // submission. Eraser stays on Ideogram / GPT-4o per the plan.
    const opt = getEditOption('gpt-image-2-atlas-edit');
    expect(opt!.maskCapable).toBe(false);
  });

  it('Atlas Edit advertises the playground price at $0.011/image (2K + low)', () => {
    // $0.011 verified via the Atlas playground 2026-05-25 at low
    // quality + 2560×1440. Atlas Edit is actually token-billed; this
    // is the playground's quoted run cost at our default settings.
    // The route logs per-call token counts so we can true up.
    const opt = getEditOption('gpt-image-2-atlas-edit');
    expect(opt!.pricePerImage).toBe(0.011);
  });

  it('formatted label includes the verified playground price', () => {
    const opt = getEditOption('gpt-image-2-atlas-edit')!;
    const label = formatEditOptionLabel(opt);
    expect(label).toBe('GPT Image 2 Edit (Atlas) — $0.011');
  });

  it('Atlas Edit backend defaults to 2560x1440 native 16:9 at low quality', () => {
    // Same defaults as the t2i + i2i Atlas entries: 2K native 16:9 +
    // low quality. Atlas Edit preserves input aspect, so the size
    // hint mostly governs the upscale-eligibility downstream
    // (>2000px skips Recraft). Locked with user 2026-05-25.
    const opt = getEditOption('gpt-image-2-atlas-edit')!;
    if (opt.backend.kind === 'atlas') {
      expect(opt.backend.atlasSize).toBe('2560x1440');
      expect(opt.backend.atlasQuality).toBe('low');
    }
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

  it('every atlas option declares its atlasModel literal', () => {
    // The EditBackend union narrows atlasModel to a literal so a typo'd
    // model string fails at compile time. If a future Atlas entry omits
    // it, this fires at PR-review time instead of in production.
    for (const opt of EDIT_OPTIONS) {
      if (opt.backend.kind === 'atlas') {
        expect(opt.backend.atlasModel).toBe('openai/gpt-image-2/edit');
      }
    }
  });

  it('every atlas option must declare maskCapable: false (Atlas has no mask param)', () => {
    for (const opt of EDIT_OPTIONS) {
      if (opt.backend.kind === 'atlas') {
        expect(
          opt.maskCapable,
          `Atlas option ${opt.id} cannot be maskCapable — Atlas Edit endpoint does not accept masks`,
        ).toBe(false);
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

  it('every kie-standard kieModel has a known input builder', () => {
    // Mirrors the if/else ladder in
    // src/app/api/generate/production-doc/image/edit/route.ts:
    // `buildKieStandardInput`. Any new catalog row using a kieModel
    // not in this set will fail at first call with "No input
    // builder for Kie model: X". Failing this test makes that
    // surface at PR-review time instead.
    const ROUTE_KNOWN_MODELS = new Set([
      'google/nano-banana-edit',
      'qwen/image-edit',
      'qwen2/image-edit',
      'seedream/4.5-edit',
      'bytedance/seedream-v4-edit',
      'ideogram/v3-edit',
    ]);
    for (const opt of EDIT_OPTIONS) {
      if (opt.backend.kind === 'kie-standard') {
        expect(ROUTE_KNOWN_MODELS.has(opt.backend.kieModel)).toBe(true);
      }
    }
  });
});
