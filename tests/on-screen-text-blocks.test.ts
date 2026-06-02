/**
 * Unit tests for the multi-block OST data shape.
 *
 * PR 4 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 *
 * Covers:
 *   - `sanitizeOnScreenTextBlocks` from `src/lib/project/payload.ts`:
 *     defense-in-depth at the payload boundary (rule 13). Drops
 *     malformed entries, clamps numeric ranges, caps array length.
 *   - `resolveOnScreenTextBlocks` from `src/remotion/utils.ts`: the
 *     renderer-side resolver. Returns blocks verbatim when present,
 *     synthesizes a single legacy-position block when only the legacy
 *     `on_screen_text` string is set, returns empty otherwise.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeOnScreenTextBlocks } from '@/lib/project/payload';
import {
  resolveOnScreenTextBlocks,
  ON_SCREEN_TEXT_BLOCK_LIMITS,
  type OnScreenTextBlock,
} from '@/remotion/utils';

describe('sanitizeOnScreenTextBlocks — boundary defense', () => {
  it('returns empty + unchanged for undefined / null input', () => {
    expect(sanitizeOnScreenTextBlocks(undefined)).toEqual({ value: [], changed: false, note: '' });
    expect(sanitizeOnScreenTextBlocks(null)).toEqual({ value: [], changed: false, note: '' });
  });

  it('rejects non-array values with a :not-array note', () => {
    const result = sanitizeOnScreenTextBlocks('whatever');
    expect(result.value).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.note).toContain('not-array');
  });

  it('drops entries with missing id', () => {
    const result = sanitizeOnScreenTextBlocks([
      { text: 'no id', x_pct: 50, y_pct: 88, scale: 1 },
    ]);
    expect(result.value).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('drops entries with non-string text', () => {
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: 123, x_pct: 50, y_pct: 88, scale: 1 },
    ]);
    expect(result.value).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('clamps over-long text to maxTextChars', () => {
    const longText = 'x'.repeat(ON_SCREEN_TEXT_BLOCK_LIMITS.maxTextChars + 100);
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: longText, x_pct: 50, y_pct: 88, scale: 1 },
    ]);
    expect(result.value).toHaveLength(1);
    expect(result.value[0].text.length).toBe(ON_SCREEN_TEXT_BLOCK_LIMITS.maxTextChars);
    expect(result.changed).toBe(true);
    expect(result.note).toContain('clamped');
  });

  it('clamps numeric fields out of range', () => {
    const result = sanitizeOnScreenTextBlocks([
      {
        id: 'a',
        text: 'hi',
        x_pct: 999, // > xPctMax (150)
        y_pct: -999, // < yPctMin (-50)
        scale: 99, // > scaleMax (3)
        rotation_deg: 90, // > rotationDegMax (45)
      },
    ]);
    expect(result.value).toHaveLength(1);
    expect(result.value[0].x_pct).toBe(ON_SCREEN_TEXT_BLOCK_LIMITS.xPctMax);
    expect(result.value[0].y_pct).toBe(ON_SCREEN_TEXT_BLOCK_LIMITS.yPctMin);
    expect(result.value[0].scale).toBe(ON_SCREEN_TEXT_BLOCK_LIMITS.scaleMax);
    expect(result.value[0].rotation_deg).toBe(ON_SCREEN_TEXT_BLOCK_LIMITS.rotationDegMax);
    expect(result.changed).toBe(true);
  });

  it('falls back to default position when numeric fields are missing or NaN', () => {
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: 'hi' },
      { id: 'b', text: 'hi2', x_pct: NaN, y_pct: NaN, scale: NaN },
    ]);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({ id: 'a', x_pct: 50, y_pct: 88, scale: 1 });
    expect(result.value[1]).toMatchObject({ id: 'b', x_pct: 50, y_pct: 88, scale: 1 });
  });

  it('rejects unknown anchor values', () => {
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 88, scale: 1, anchor: 'middle-of-galaxy' },
    ]);
    expect(result.value[0].anchor).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it('rejects unknown variant values', () => {
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 88, scale: 1, variant: 'pink-neon' },
    ]);
    expect(result.value[0].variant).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it('accepts every valid anchor + variant', () => {
    const result = sanitizeOnScreenTextBlocks([
      { id: 'a', text: 't1', x_pct: 0, y_pct: 0, scale: 1, anchor: 'top-left', variant: 'doodle-yellow' },
      { id: 'b', text: 't2', x_pct: 100, y_pct: 100, scale: 1, anchor: 'bottom-right', variant: 'default' },
    ]);
    expect(result.value).toHaveLength(2);
    expect(result.value[0].anchor).toBe('top-left');
    expect(result.value[0].variant).toBe('doodle-yellow');
    expect(result.changed).toBe(false);
  });

  it('caps the array at maxBlocksPerShot', () => {
    const tooMany = Array.from({ length: ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot + 3 }, (_, i) => ({
      id: `b${i}`,
      text: `t${i}`,
      x_pct: 50,
      y_pct: 88,
      scale: 1,
    }));
    const result = sanitizeOnScreenTextBlocks(tooMany);
    expect(result.value).toHaveLength(ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot);
    expect(result.changed).toBe(true);
    expect(result.note).toContain('over-cap');
  });
});

describe('resolveOnScreenTextBlocks — renderer-side resolver', () => {
  it('returns the blocks array verbatim when present + non-empty', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 10, y_pct: 20, scale: 1.5 },
    ];
    const result = resolveOnScreenTextBlocks({
      blocks,
      legacyOnScreenText: 'this should be ignored',
    });
    expect(result).toEqual(blocks);
  });

  it('synthesizes a single legacy-position block when only legacy text is set', () => {
    const result = resolveOnScreenTextBlocks({
      blocks: undefined,
      legacyOnScreenText: 'Hello',
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'Hello',
      x_pct: 50,
      y_pct: 88,
      scale: 1,
      anchor: 'bottom-center',
    });
    expect(result[0].id).toMatch(/^legacy:/);
  });

  it('treats an empty blocks array the same as undefined (falls through to legacy)', () => {
    const result = resolveOnScreenTextBlocks({
      blocks: [],
      legacyOnScreenText: 'Hello',
    });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello');
  });

  it('returns empty when neither blocks nor legacy text is set', () => {
    expect(resolveOnScreenTextBlocks({ blocks: undefined, legacyOnScreenText: undefined })).toEqual([]);
    expect(resolveOnScreenTextBlocks({ blocks: undefined, legacyOnScreenText: '' })).toEqual([]);
    expect(resolveOnScreenTextBlocks({ blocks: undefined, legacyOnScreenText: '   ' })).toEqual([]);
  });

  it('does not mutate the input blocks array', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 0, y_pct: 0, scale: 1 },
    ];
    const result = resolveOnScreenTextBlocks({ blocks, legacyOnScreenText: undefined });
    expect(result).not.toBe(blocks); // returns a copy
    expect(result).toEqual(blocks);
  });
});
