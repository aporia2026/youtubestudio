import { describe, expect, it } from 'vitest';
import { scriptGenerationPrompt, thumbnailConceptPrompt } from '@/lib/prompts';

/**
 * Phase 1 of `_plans/2026-05-19-analyzer-as-input-source.md` — wire a
 * resolved style preset (built-in slug or saved row) into the script
 * and thumbnail prompt builders. These tests pin the contract:
 *
 *   - `stylePreset === null/undefined` → byte-identical to the
 *     pre-preset prompt (backwards compat for every existing caller).
 *   - `stylePreset` supplied with description/mixing_rules → block
 *     appears in the user prompt with the preset's label and content.
 *   - For thumbnails specifically, `ai_image_suffix` makes its way
 *     into the `image_generation_prompt` instruction so each downstream
 *     image-gen prompt ends with the suffix verbatim.
 */

describe('scriptGenerationPrompt — stylePreset wiring (Phase 1.1)', () => {
  const base = {
    topic: 'Why no two people see the same rainbow',
    niche: 'Science',
    targetDurationMinutes: 10,
  };

  it('produces an unchanged prompt when stylePreset is null', () => {
    const withoutPreset = scriptGenerationPrompt({ ...base, stylePreset: null });
    const original = scriptGenerationPrompt(base);
    expect(withoutPreset.user).toBe(original.user);
    expect(withoutPreset.system).toBe(original.system);
  });

  it('produces an unchanged prompt when stylePreset is undefined', () => {
    const omitted = scriptGenerationPrompt(base);
    const original = scriptGenerationPrompt({ ...base });
    expect(omitted.user).toBe(original.user);
  });

  it('omits the block when the preset has only a label (no description, no mixing_rules)', () => {
    const labelOnly = scriptGenerationPrompt({
      ...base,
      stylePreset: { label: 'Veritasium-cinematic' },
    });
    const original = scriptGenerationPrompt(base);
    expect(labelOnly.user).toBe(original.user);
  });

  it('injects the STYLE PRESET block with description when supplied', () => {
    const out = scriptGenerationPrompt({
      ...base,
      stylePreset: {
        label: 'Veritasium-cinematic',
        description: 'Considered cinematic explainer with B-roll',
      },
    });
    expect(out.user).toMatch(/STYLE PRESET — "Veritasium-cinematic"/);
    expect(out.user).toMatch(/Considered cinematic explainer with B-roll/);
  });

  it('injects mixing_rules verbatim when supplied', () => {
    const out = scriptGenerationPrompt({
      ...base,
      stylePreset: {
        label: 'Casey-handheld',
        mixing_rules: 'Open every chapter with a single concrete action verb.',
      },
    });
    expect(out.user).toMatch(/Casey-handheld/);
    expect(out.user).toMatch(/Open every chapter with a single concrete action verb\./);
  });
});

describe('thumbnailConceptPrompt — stylePreset wiring (Phase 1.2)', () => {
  const base = {
    title: 'Why Casey Spent His Nike Budget on a 10-Day Trip',
    niche: 'Entertainment',
  };

  it('produces an unchanged prompt when stylePreset is null', () => {
    const withoutPreset = thumbnailConceptPrompt({ ...base, stylePreset: null });
    const original = thumbnailConceptPrompt(base);
    expect(withoutPreset.user).toBe(original.user);
    expect(withoutPreset.system).toBe(original.system);
  });

  it('omits the block when the preset has only a label', () => {
    const labelOnly = thumbnailConceptPrompt({
      ...base,
      stylePreset: { label: 'Travel-vlog-card' },
    });
    const original = thumbnailConceptPrompt(base);
    expect(labelOnly.user).toBe(original.user);
  });

  it('injects the STYLE PRESET block and the image suffix instruction', () => {
    const out = thumbnailConceptPrompt({
      ...base,
      stylePreset: {
        label: 'Travel-vlog-card',
        ai_image_suffix: 'handheld vlog still, motion blur, warm grade',
        mixing_rules: 'Use a single hero subject; no composite scenes.',
      },
    });
    expect(out.user).toMatch(/STYLE PRESET — "Travel-vlog-card"/);
    expect(out.user).toMatch(/handheld vlog still, motion blur, warm grade/);
    expect(out.user).toMatch(/Use a single hero subject/);
    // The image_generation_prompt instruction must mention appending
    // the suffix verbatim so downstream image-gen ends with it.
    expect(out.user).toMatch(/APPEND verbatim at the end of the prompt/);
  });

  it('only injects the suffix instruction when ai_image_suffix is present', () => {
    const noSuffix = thumbnailConceptPrompt({
      ...base,
      stylePreset: {
        label: 'mixing-only',
        mixing_rules: 'Use only flat color, no photography.',
      },
    });
    // Block IS present (mixing_rules drove it), but the suffix-append
    // instruction is NOT — we don't tell the model to append something
    // that doesn't exist.
    expect(noSuffix.user).toMatch(/STYLE PRESET — "mixing-only"/);
    expect(noSuffix.user).not.toMatch(/APPEND verbatim at the end of the prompt/);
  });
});
