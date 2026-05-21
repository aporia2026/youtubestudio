import { describe, expect, it } from 'vitest';
import { buildSheetPrompt, resolveSheetReference } from '@/lib/style-sheet';

describe('buildSheetPrompt', () => {
  it('emits a 2x2 grid prompt when hasProtagonist=true', () => {
    const out = buildSheetPrompt({
      stylePrompt: 'flat 2D vector, muted earth tones',
      hasProtagonist: true,
    });
    expect(out).toContain('2×2 grid');
    expect(out).toContain('front view');
    expect(out).toContain('palette swatch');
    expect(out).toContain('flat 2D vector, muted earth tones');
  });

  it('emits a no-character scene when hasProtagonist=false', () => {
    const out = buildSheetPrompt({
      stylePrompt: 'noir illustration, high contrast',
      hasProtagonist: false,
    });
    expect(out).toContain('No characters');
    expect(out).toContain('palette, line weight');
    expect(out).not.toContain('protagonist');
    expect(out).toContain('noir illustration');
  });

  it('injects the protagonistDescription clause when provided', () => {
    const out = buildSheetPrompt({
      stylePrompt: 'comic book',
      hasProtagonist: true,
      protagonistDescription: 'a red-headed engineer in a green hoodie',
    });
    expect(out).toContain('a red-headed engineer in a green hoodie');
  });

  it('caps the style prompt at 600 chars (no token explosion)', () => {
    const out = buildSheetPrompt({
      stylePrompt: 'x'.repeat(2000),
      hasProtagonist: false,
    });
    // 600 chars max + the surrounding scaffolding
    expect(out.length).toBeLessThan(2000);
  });

  it('caps the protagonist description at 200 chars', () => {
    const out = buildSheetPrompt({
      stylePrompt: 'comic',
      hasProtagonist: true,
      protagonistDescription: 'y'.repeat(2000),
    });
    expect(out).toContain('y'.repeat(200));
    expect(out).not.toContain('y'.repeat(201));
  });

  it('handles an empty style prompt gracefully', () => {
    const out = buildSheetPrompt({ stylePrompt: '', hasProtagonist: false });
    expect(out).not.toContain('Style:');
    expect(out).toContain('No characters');
  });
});

describe('resolveSheetReference', () => {
  it('returns the doc URL + description when the row does not opt out', () => {
    const out = resolveSheetReference(
      {},
      { style_sheet_url: 'https://r2.example.com/sheet.png', style_sheet_description: 'noir' },
    );
    expect(out.referenceImageUrl).toBe('https://r2.example.com/sheet.png');
    expect(out.styleSheetDescription).toBe('noir');
  });

  it('returns undefined for both fields when the row opts out', () => {
    const out = resolveSheetReference(
      { style_sheet_skip: true },
      { style_sheet_url: 'https://r2.example.com/sheet.png', style_sheet_description: 'noir' },
    );
    expect(out.referenceImageUrl).toBeUndefined();
    expect(out.styleSheetDescription).toBeUndefined();
  });

  it('returns undefined when the doc has no sheet', () => {
    const out = resolveSheetReference({}, {});
    expect(out.referenceImageUrl).toBeUndefined();
    expect(out.styleSheetDescription).toBeUndefined();
  });

  it('trims whitespace and treats empty strings as missing', () => {
    const out = resolveSheetReference(
      {},
      { style_sheet_url: '   ', style_sheet_description: '   ' },
    );
    expect(out.referenceImageUrl).toBeUndefined();
    expect(out.styleSheetDescription).toBeUndefined();
  });

  it('skip=false explicitly still uses the sheet', () => {
    const out = resolveSheetReference(
      { style_sheet_skip: false },
      { style_sheet_url: 'https://r2.example.com/sheet.png' },
    );
    expect(out.referenceImageUrl).toBe('https://r2.example.com/sheet.png');
  });
});
