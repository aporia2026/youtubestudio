/**
 * Unit tests for the `effectiveStyleSlug` option of `productionDocToVideoConfig`.
 *
 * Regression target: doodle_explainer_2 docs were rendering OST with the
 * default red/black/white LowerThird because (a) the doc had its
 * `on_screen_text_mode_default` left at undefined → falls through to 'bake',
 * meaning the renderer never mounts a LowerThird at all OR (b) the doc used
 * a saved-style UUID and `config.styleId === 'doodle_explainer_2'` was a
 * literal-slug check that silently failed.
 *
 * This test covers the literal-slug check side: `productionDocToVideoConfig`
 * now accepts `opts.effectiveStyleSlug` and uses it to populate `styleId`
 * when set, so SceneRouter's variant resolver sees the built-in slug even
 * for saved-style UUIDs.
 *
 * PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 */

import { describe, expect, it } from 'vitest';
import { productionDocToVideoConfig, type ProductionDoc } from '@/remotion/utils';

function minimalDoc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    title: 'Test',
    niche: 'Test',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows: [
      {
        timecode: '0:00',
        script_text: 'hello world',
        visual_type: 'B-Roll',
        visual_description: 'a thing',
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: '',
        notes: '',
      },
    ],
    ...overrides,
  };
}

describe('productionDocToVideoConfig — effectiveStyleSlug', () => {
  it('populates config.styleId from doc.style_preset when effectiveStyleSlug is undefined (legacy back-compat)', () => {
    const doc = minimalDoc({ style_preset: 'doodle_explainer_2' });
    const config = productionDocToVideoConfig(doc, [null]);
    expect(config.styleId).toBe('doodle_explainer_2');
  });

  it('populates config.styleId from doc.style_preset (UUID) when effectiveStyleSlug is undefined', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const doc = minimalDoc({ style_preset: uuid });
    const config = productionDocToVideoConfig(doc, [null]);
    expect(config.styleId).toBe(uuid);
  });

  it('overrides config.styleId with effectiveStyleSlug when set (saved-style UUID → built-in slug)', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const doc = minimalDoc({ style_preset: uuid });
    const config = productionDocToVideoConfig(doc, [null], {
      effectiveStyleSlug: 'doodle_explainer_2',
    });
    // This is the fix path: SceneRouter's `=== 'doodle_explainer_2'`
    // check now sees the built-in slug, not the saved-style UUID, so
    // doodle-yellow LowerThird resolves correctly.
    expect(config.styleId).toBe('doodle_explainer_2');
  });

  it('preserves config.styleId override even when doc.style_preset is missing', () => {
    const doc = minimalDoc({ style_preset: undefined });
    const config = productionDocToVideoConfig(doc, [null], {
      effectiveStyleSlug: 'paint_explainer_v1',
    });
    expect(config.styleId).toBe('paint_explainer_v1');
  });

  it('leaves config.styleId undefined when both doc.style_preset and effectiveStyleSlug are unset', () => {
    const doc = minimalDoc();
    const config = productionDocToVideoConfig(doc, [null]);
    expect(config.styleId).toBeUndefined();
  });

  it('paintExplainerV1Settings resolves when effectiveStyleSlug === paint_explainer_v1 even if doc.style_preset is a UUID', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const doc = minimalDoc({ style_preset: uuid });
    const config = productionDocToVideoConfig(doc, [null], {
      effectiveStyleSlug: 'paint_explainer_v1',
    });
    // paintExplainerV1Settings used to gate on doc.style_preset only;
    // now also accepts effectiveStyleSlug so saved styles derived from
    // paint_explainer_v1 light up the paint-aware code paths.
    expect(config.paintExplainerV1Settings).toBeDefined();
  });
});
