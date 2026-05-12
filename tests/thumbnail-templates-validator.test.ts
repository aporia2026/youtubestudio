import { describe, expect, it } from 'vitest';
import { validateThumbnailTemplateInput } from '@/lib/thumbnail-templates';

describe('validateThumbnailTemplateInput — strict (POST) mode', () => {
  it('requires the body to be a JSON object', () => {
    expect(validateThumbnailTemplateInput(null)).toEqual({ ok: false, reason: 'Body must be a JSON object.' });
    expect(validateThumbnailTemplateInput('string')).toEqual({ ok: false, reason: 'Body must be a JSON object.' });
    expect(validateThumbnailTemplateInput([])).toEqual({ ok: false, reason: 'Body must be a JSON object.' });
  });

  it('requires name to be present', () => {
    const r = validateThumbnailTemplateInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/name is required/);
  });

  it('rejects empty / whitespace name', () => {
    expect(validateThumbnailTemplateInput({ name: '' }).ok).toBe(false);
    expect(validateThumbnailTemplateInput({ name: '   ' }).ok).toBe(false);
  });

  it('rejects names over 200 chars', () => {
    const r = validateThumbnailTemplateInput({ name: 'x'.repeat(201) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/200 chars/);
  });

  it('trims name', () => {
    const r = validateThumbnailTemplateInput({ name: '   My template   ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('My template');
  });

  it('accepts an empty image_references array', () => {
    const r = validateThumbnailTemplateInput({ name: 'X', image_references: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.image_references).toEqual([]);
  });

  it('rejects non-array image_references', () => {
    expect(validateThumbnailTemplateInput({ name: 'X', image_references: 'not an array' }).ok).toBe(false);
  });

  it('rejects > 10 image_references', () => {
    const refs = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.jpg`);
    expect(validateThumbnailTemplateInput({ name: 'X', image_references: refs }).ok).toBe(false);
  });

  it('filters out empty / blank image_reference strings', () => {
    const r = validateThumbnailTemplateInput({
      name: 'X',
      image_references: ['https://a.jpg', '', '   ', 'https://b.jpg'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.image_references).toEqual(['https://a.jpg', 'https://b.jpg']);
  });

  it('rejects non-string image_references', () => {
    expect(
      validateThumbnailTemplateInput({ name: 'X', image_references: ['https://a.jpg', 42] }).ok,
    ).toBe(false);
  });

  it('rejects context_description that is not a string or null', () => {
    expect(validateThumbnailTemplateInput({ name: 'X', context_description: 42 }).ok).toBe(false);
  });

  it('rejects context_description over 5000 chars', () => {
    const r = validateThumbnailTemplateInput({
      name: 'X',
      context_description: 'a'.repeat(5001),
    });
    expect(r.ok).toBe(false);
  });

  it('accepts null context_description', () => {
    const r = validateThumbnailTemplateInput({ name: 'X', context_description: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.context_description).toBeNull();
  });

  it('rejects non-boolean include_text', () => {
    expect(validateThumbnailTemplateInput({ name: 'X', include_text: 'true' }).ok).toBe(false);
  });

  it('rejects text_overlay_config with unknown keys', () => {
    expect(
      validateThumbnailTemplateInput({
        name: 'X',
        text_overlay_config: { rogue: 'value' },
      }).ok,
    ).toBe(false);
  });

  it('accepts text_overlay_config with allowed keys only', () => {
    const r = validateThumbnailTemplateInput({
      name: 'X',
      text_overlay_config: { text: 'HOOK', position: 'center', font_size: 96, color: '#fff' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects text_overlay_config that is an array (not an object)', () => {
    expect(validateThumbnailTemplateInput({ name: 'X', text_overlay_config: [] }).ok).toBe(false);
  });

  it('accepts null text_overlay_config', () => {
    const r = validateThumbnailTemplateInput({ name: 'X', text_overlay_config: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text_overlay_config).toBeNull();
  });
});

describe('validateThumbnailTemplateInput — partial (PATCH) mode', () => {
  it('allows missing name', () => {
    const r = validateThumbnailTemplateInput({ context_description: 'just the desc' }, { allowPartial: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('');
      expect(r.value.context_description).toBe('just the desc');
    }
  });

  it('still rejects an explicit empty name when provided in partial mode', () => {
    const r = validateThumbnailTemplateInput({ name: '' }, { allowPartial: true });
    expect(r.ok).toBe(false);
  });
});
