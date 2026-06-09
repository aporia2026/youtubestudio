import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOUD_I2I_MODEL,
  getI2iCounterpartForT2i,
  resolveI2iModelForRow,
} from '@/lib/image-models-i2i';

// Resolves the i2i model for a ref-bearing generation given the row's
// per-shot picker pick + the style's `preferred_cloud_model`. Pins the
// resolution chain so the 2026-06-09 fix ("I picked Kie but it still hit
// Atlas") cannot regress.

describe('getI2iCounterpartForT2i', () => {
  it('pairs Kie GPT Image 2 t2i with Kie GPT Image 2 i2i', () => {
    expect(getI2iCounterpartForT2i('gpt-image-2-t2i')).toBe('gpt-image-2-i2i');
  });

  it('pairs Atlas GPT Image 2 t2i with Atlas GPT Image 2 i2i (preserves vendor)', () => {
    expect(getI2iCounterpartForT2i('gpt-image-2-atlas-t2i')).toBe('gpt-image-2-atlas-i2i');
  });

  it('pairs NanoBanana with NanoBanana i2i (legacy picker value)', () => {
    expect(getI2iCounterpartForT2i('nano-banana')).toBe('nano-banana-2-i2i');
  });

  it('pairs Flux 2 Pro t2i with Flux 2 Pro i2i', () => {
    expect(getI2iCounterpartForT2i('flux2-pro-t2i')).toBe('flux2-pro-i2i');
  });

  it('returns undefined for Ideogram t2i (no i2i sibling — text-only model)', () => {
    expect(getI2iCounterpartForT2i('ideogram-v3-quality-t2i')).toBeUndefined();
    expect(getI2iCounterpartForT2i('ideogram-v3-turbo-t2i')).toBeUndefined();
  });

  it('returns undefined for Flux 2 Flex t2i (only Pro has i2i in the registry)', () => {
    expect(getI2iCounterpartForT2i('flux2-flex-t2i')).toBeUndefined();
  });

  it('returns undefined for an unknown id rather than guessing', () => {
    expect(getI2iCounterpartForT2i('mystery-model')).toBeUndefined();
    expect(getI2iCounterpartForT2i('')).toBeUndefined();
  });
});

describe('resolveI2iModelForRow', () => {
  // ─── The bug this fix addresses ───────────────────────────────────────
  it('picking Kie GPT Image 2 in the inspector now routes through Kie i2i (was hitting Atlas before 2026-06-09)', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: 'gpt-image-2-t2i',
      stylePreferred: 'gpt-image-2-atlas-i2i',
    });
    expect(result.i2iModel).toBe('gpt-image-2-i2i');
    expect(result.source).toBe('row-pick-mapped-from-t2i');
  });

  it('picking Atlas GPT Image 2 stays on Atlas i2i even when the style preferred Kie i2i', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: 'gpt-image-2-atlas-t2i',
      stylePreferred: 'gpt-image-2-i2i',
    });
    expect(result.i2iModel).toBe('gpt-image-2-atlas-i2i');
    expect(result.source).toBe('row-pick-mapped-from-t2i');
  });

  // ─── Direct i2i pick (future-friendly) ────────────────────────────────
  it('an already-i2i row pick passes through untouched', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: 'gpt-image-2-i2i',
      stylePreferred: 'gpt-image-2-atlas-i2i',
    });
    expect(result.i2iModel).toBe('gpt-image-2-i2i');
    expect(result.source).toBe('row-pick-direct');
  });

  // ─── Picks with no i2i counterpart fall back to the style preference ──
  it('Ideogram pick has no i2i sibling — falls back to the style preferred model', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: 'ideogram-v3-quality-t2i',
      stylePreferred: 'gpt-image-2-atlas-i2i',
    });
    expect(result.i2iModel).toBe('gpt-image-2-atlas-i2i');
    expect(result.source).toBe('style-preferred');
  });

  // ─── No row pick = style preferred wins (current production-doc default) ─
  it('no row pick + valid style preferred → style wins', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: undefined,
      stylePreferred: 'gpt-image-2-atlas-i2i',
    });
    expect(result.i2iModel).toBe('gpt-image-2-atlas-i2i');
    expect(result.source).toBe('style-preferred');
  });

  it('no row pick + null style preferred → default', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: undefined,
      stylePreferred: null,
    });
    expect(result.i2iModel).toBe(DEFAULT_CLOUD_I2I_MODEL);
    expect(result.source).toBe('default');
  });

  it('no row pick + unknown style preferred → default (registry drift fallback)', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: undefined,
      stylePreferred: 'nano-banana-pro-i2i', // retired value, see image-models-i2i.ts:259
    });
    expect(result.i2iModel).toBe(DEFAULT_CLOUD_I2I_MODEL);
    expect(result.source).toBe('default');
  });

  it('unknown row pick + unknown style preferred → default', () => {
    const result = resolveI2iModelForRow({
      rowPickedModel: 'mystery-model',
      stylePreferred: 'also-mystery',
    });
    expect(result.i2iModel).toBe(DEFAULT_CLOUD_I2I_MODEL);
    expect(result.source).toBe('default');
  });
});
