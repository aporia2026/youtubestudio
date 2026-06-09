/**
 * Unit tests for <ConvertToMotionCollageButton>.
 *
 * Pinned-behaviour tests (renderToStaticMarkup) only — the click path
 * fires a network call we can't exercise without a mock harness. The
 * component's `null` return contract is the critical part: it must
 * appear ONLY when the doc is doodle-style AND the row isn't already
 * a motion collage AND the row isn't a Title Card.
 *
 * PR 4 of `_plans/2026-06-02-editor-motion-collage-support.md`.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConvertToMotionCollageButton } from '@/components/editor/inspector/ConvertToMotionCollageButton';
import type { ProductionDoc } from '@/remotion/utils';

function makeRow(fields: Partial<ProductionDoc['rows'][number]> = {}): ProductionDoc['rows'][number] {
  return {
    timecode: '0:00',
    script_text: 'something happens',
    visual_type: 'Animation',
    visual_description: 'a scene',
    stock_search_terms: '',
    ai_image_prompt: 'a scene of motion',
    on_screen_text: '',
    notes: '',
    ...fields,
  };
}

function makeDoc(stylePreset: string | undefined): ProductionDoc {
  return {
    title: 'T',
    niche: 'X',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows: [],
    style_preset: stylePreset,
  };
}

describe('ConvertToMotionCollageButton — visibility gates', () => {
  it('renders for an Animation row on a doodle_explainer_2 doc', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow({ visual_type: 'Animation' })}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Convert to motion collage');
  });

  it('renders when style_preset is a saved-style UUID (real-world case)', () => {
    // 2026-06-02 user-reported bug: a saved style derived from
    // doodle_explainer_2 hid the button because its DB row lacked
    // the based_on_built_in link. The gate is now permissive — any
    // non-Title-Card / non-motion-collage row shows the button.
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('521adb81-8e15-4b27-91c7-1bc68f572280')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Convert to motion collage');
  });

  it('renders even when doc style is a non-doodle built-in (gate intentionally loose)', () => {
    // The motion-collage pipeline is doodle-specific server-side, but
    // hiding the button on legitimate doodle docs because of a data
    // gap was the worse failure mode. Button shows; tooltip surfaces
    // the resolved style.
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('cinematic')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Convert to motion collage');
    expect(html).toContain('Style: cinematic');
  });

  it('returns null when row.shot_kind is already motion_collage', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow({ shot_kind: 'motion_collage' })}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('returns null on Title Card rows', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow({ visual_type: 'Title Card' })}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders even with no style_preset set (auto-fill still works without a style suffix)', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc(undefined)}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Convert to motion collage');
  });

  it('tooltip exposes the resolved built-in slug when effectiveStyleSlug is set', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('521adb81-uuid')}
        effectiveStyleSlug="doodle_explainer_2"
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Style: doodle_explainer_2');
  });

  it('shows the auto-fill hint text so the user knows what the button does', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Auto-fills');
  });
});

describe('ConvertToMotionCollageButton — grid picker', () => {
  it('renders every grid preset (2×2 through 4×4)', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('2×2');
    expect(html).toContain('3×2');
    expect(html).toContain('2×3');
    expect(html).toContain('3×3');
    expect(html).toContain('4×3');
    expect(html).toContain('4×4');
  });

  it('defaults to 3×3 selected and surfaces the panel count on the button', () => {
    // 2026-06-09: default bumped 2×2 → 3×3. With only 4 panels the LLM
    // had to pick huge per-panel deltas which the image model
    // couldn't reproduce without breaking composition. 9 panels lets
    // the MOTION DELTA rule actually breathe.
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    // CTA includes the selected grid + total panel count.
    expect(html).toContain('Convert to motion collage (3×3)');
    expect(html).toContain('Auto-fills 9 panel prompts');
  });

  it('renders the "change grid after conversion" hint', () => {
    const html = renderToStaticMarkup(
      <ConvertToMotionCollageButton
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc('doodle_explainer_2')}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('change the grid after conversion');
  });
});
