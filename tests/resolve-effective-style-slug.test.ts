/**
 * Tests for `resolveEffectiveStyleSlug` in `src/remotion/utils.ts`.
 *
 * This is the load-bearing helper for the "OST renders as the default
 * dark/red bar instead of the yellow comic-bold variant" bug. The
 * dispatcher in `YouTubeVideo.tsx` reads `config.styleId` and gates the
 * yellow LowerThird variant on `=== 'paint_explainer_v1'` /
 * `=== 'doodle_explainer_2'`. When a caller forgot to pass
 * `opts.effectiveStyleSlug` AND the doc was edited under a saved
 * custom style (UUID), the raw UUID landed in `config.styleId`, the
 * gate failed, and every on-screen-text rendered as the dark bar.
 *
 * The resolver now sniffs style-specific signals on the doc when the
 * explicit slug isn't provided — so even a saved-style UUID doc
 * lands on the right built-in. These tests lock that down.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectiveStyleSlug } from '../src/remotion/utils';
import type { ProductionDoc } from '../src/remotion/utils';

const baseDoc = (): ProductionDoc => ({
  title: 'T',
  niche: 'tech',
  total_duration: '00:30',
  total_words: 60,
  speaking_pace_wpm: 135,
  rows: [],
});

describe('resolveEffectiveStyleSlug', () => {
  it('returns explicit slug verbatim when caller provides one', () => {
    const doc = baseDoc();
    expect(resolveEffectiveStyleSlug(doc, 'paint_explainer_v1')).toBe('paint_explainer_v1');
    expect(resolveEffectiveStyleSlug(doc, 'doodle_explainer')).toBe('doodle_explainer');
  });

  it('explicit slug wins over signal-based inference', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      paint_explainer_v1_settings: { median_shot_seconds: 2.75 } as ProductionDoc['paint_explainer_v1_settings'],
    };
    // Caller says it's a cinematic doc → trust them, ignore the signal.
    expect(resolveEffectiveStyleSlug(doc, 'cinematic')).toBe('cinematic');
  });

  it('infers paint_explainer_v1 from paint_explainer_v1_settings', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      paint_explainer_v1_settings: { median_shot_seconds: 2.75 } as ProductionDoc['paint_explainer_v1_settings'],
      // Saved-style UUID in style_preset — the bug case.
      style_preset: '550e8400-e29b-41d4-a716-446655440000',
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('paint_explainer_v1');
  });

  it('infers paint_explainer_v1 from paint_explainer_v1_prop_cache', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      paint_explainer_v1_prop_cache: { 'red-balloon': 'https://r2.example/img.png' },
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('paint_explainer_v1');
  });

  it('infers doodle_explainer_2 from doodle_explainer_2_character_cache', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      doodle_explainer_2_character_cache: {
        protagonist: { base_url: 'https://r2.example/c.png', first_seen_row_index: 0 },
      },
      style_preset: '550e8400-e29b-41d4-a716-446655440001',
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('doodle_explainer_2');
  });

  it('infers doodle_explainer_2 from doodle_explainer_2_scene_cache', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      doodle_explainer_2_scene_cache: {
        office: { base_url: 'https://r2.example/s.png', first_seen_row_index: 0 },
      },
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('doodle_explainer_2');
  });

  it('falls back to raw style_preset when no signal hits (legacy back-compat)', () => {
    const doc: ProductionDoc = {
      ...baseDoc(),
      style_preset: 'cinematic',
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('cinematic');
  });

  it('falls back to undefined when both signals and style_preset are absent', () => {
    expect(resolveEffectiveStyleSlug(baseDoc())).toBeUndefined();
  });

  it('preserves the UUID fallback when caller passes no slug AND no signals are populated', () => {
    // Pure-UUID case: the doc was created under a saved style derived
    // from a NON-built-in (no signals), so we have no way to infer.
    // Better to return the UUID than to invent a slug — downstream
    // gates simply default to the legacy "no special treatment" path.
    const doc: ProductionDoc = {
      ...baseDoc(),
      style_preset: '550e8400-e29b-41d4-a716-446655440002',
    };
    expect(resolveEffectiveStyleSlug(doc)).toBe('550e8400-e29b-41d4-a716-446655440002');
  });
});
