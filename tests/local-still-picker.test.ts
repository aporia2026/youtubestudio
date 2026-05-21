import { describe, expect, it } from 'vitest';
import { pickLocalStillModel } from '@/lib/local-still-picker';

describe('pickLocalStillModel', () => {
  // ─── Baked text ─────────────────────────────────────────────────────
  // Rule 1 (highest priority): any row whose OST mode resolves to 'bake'
  // AND has non-empty text → Qwen-Image, regardless of style-sheet
  // state. Flux schnell's BREAKING NEWS test proved glyph garbling.

  it('baked text + no sheet → Qwen (text quality matters)', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'BREAKING NEWS', on_screen_text_mode: 'bake' },
      doc: {},
    });
    expect(out).toEqual({ model: 'qwen-image-local', reason: 'baked_text' });
  });

  it('baked text + sheet → Qwen (baked-text rule beats style-sheet rule)', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'BREAKING NEWS', on_screen_text_mode: 'bake' },
      doc: { style_sheet_url: 'https://r2.example.com/sheet.png' },
    });
    expect(out.model).toBe('qwen-image-local');
    expect(out.reason).toBe('baked_text');
  });

  it('inherits doc-default mode when row has none', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'INTRO' },
      doc: { on_screen_text_mode_default: 'bake' },
    });
    expect(out.model).toBe('qwen-image-local');
    expect(out.reason).toBe('baked_text');
  });

  it('empty OST text in bake mode still falls through to next rule', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: '', on_screen_text_mode: 'bake' },
      doc: { style_sheet_url: 'https://r2.example.com/sheet.png' },
    });
    expect(out.model).toBe('qwen-image-local');
    expect(out.reason).toBe('style_sheet');
  });

  it('whitespace-only OST text counts as empty', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: '   \t  ', on_screen_text_mode: 'bake' },
      doc: {},
    });
    expect(out).toEqual({ model: 'flux-schnell-local', reason: 'default' });
  });

  // ─── Style sheet ────────────────────────────────────────────────────
  // Rule 2: row doesn't have baked text but the doc carries a style
  // sheet → Qwen. The i2i chain at denoise 0.7 needs a model that follows
  // prompts under heavy reference conditioning; Flux schnell anchors
  // too hard.

  it('no baked text + sheet → Qwen (style-sheet rule)', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'BANNER', on_screen_text_mode: 'overlay' },
      doc: { style_sheet_url: 'https://r2.example.com/sheet.png' },
    });
    expect(out).toEqual({ model: 'qwen-image-local', reason: 'style_sheet' });
  });

  it('empty sheet URL string counts as no sheet', () => {
    const out = pickLocalStillModel({
      row: {},
      doc: { style_sheet_url: '   ' },
    });
    expect(out).toEqual({ model: 'flux-schnell-local', reason: 'default' });
  });

  it('mode=none with a sheet still picks Qwen (sheet rule applies)', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'INTRO', on_screen_text_mode: 'none' },
      doc: { style_sheet_url: 'https://r2.example.com/sheet.png' },
    });
    expect(out.model).toBe('qwen-image-local');
    expect(out.reason).toBe('style_sheet');
  });

  // ─── Default ────────────────────────────────────────────────────────
  // Rule 3: nothing fancy going on → Flux schnell. Fast iteration is the
  // right default when there's no sheet and no baked text to worry about.

  it('no baked text, no sheet → Flux schnell (default rule)', () => {
    const out = pickLocalStillModel({ row: {}, doc: {} });
    expect(out).toEqual({ model: 'flux-schnell-local', reason: 'default' });
  });

  it('overlay text on unstyled doc → Flux schnell (no need for typography model)', () => {
    const out = pickLocalStillModel({
      row: { on_screen_text: 'BANNER', on_screen_text_mode: 'overlay' },
      doc: {},
    });
    expect(out).toEqual({ model: 'flux-schnell-local', reason: 'default' });
  });
});
