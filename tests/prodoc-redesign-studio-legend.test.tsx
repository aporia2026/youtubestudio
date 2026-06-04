/**
 * StudioLegend — horizontal scene-type breakdown rendered under the
 * Studio top bar. Phase R2 PR2 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Also covers `src/lib/visual-type-colors.ts` — the shared token map
 * extracted from page.tsx so the legend and the legacy pills can never
 * drift.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioLegend } from '@/components/production-doc/redesign/StudioLegend';
import {
  VISUAL_TYPE_COLORS,
  VISUAL_TYPE_COLOR_FALLBACK,
  getVisualTypeColor,
} from '@/lib/visual-type-colors';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

function makeRow(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'sample',
    niche: 'finance',
    total_duration: '1:00',
    total_words: 100,
    speaking_pace_wpm: 125,
    rows,
  };
}

describe('VISUAL_TYPE_COLORS — token map', () => {
  it('exports tokens for every documented visual type', () => {
    expect(Object.keys(VISUAL_TYPE_COLORS)).toEqual(
      expect.arrayContaining([
        'Title Card',
        'B-Roll',
        'Talking Head',
        'Screen Recording',
        'Animation',
        'Lower Third',
        'Statistics',
        'Cutaway',
      ]),
    );
  });

  it('each token has a bg and a color string', () => {
    for (const [type, token] of Object.entries(VISUAL_TYPE_COLORS)) {
      expect(typeof token.bg).toBe('string');
      expect(typeof token.color).toBe('string');
      expect(token.bg, `missing bg for ${type}`).toBeTruthy();
      expect(token.color, `missing color for ${type}`).toBeTruthy();
    }
  });
});

describe('getVisualTypeColor — fallback behavior', () => {
  it('returns the documented token for known types', () => {
    expect(getVisualTypeColor('B-Roll')).toBe(VISUAL_TYPE_COLORS['B-Roll']);
  });

  it('returns the neutral fallback for unknown types instead of throwing', () => {
    expect(getVisualTypeColor('Unknown Custom Type')).toBe(VISUAL_TYPE_COLOR_FALLBACK);
  });
});

describe('StudioLegend — content', () => {
  it('renders one pill per distinct visual type that appears in the doc', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([
          makeRow({ visual_type: 'Title Card' }),
          makeRow({ visual_type: 'Title Card' }),
          makeRow({ visual_type: 'B-Roll' }),
          makeRow({ visual_type: 'Animation' }),
        ])}
      />,
    );
    expect(html).toContain('Title Card');
    expect(html).toContain('B-Roll');
    expect(html).toContain('Animation');
  });

  it('shows the count next to each type', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([
          makeRow({ visual_type: 'Title Card' }),
          makeRow({ visual_type: 'Title Card' }),
          makeRow({ visual_type: 'B-Roll' }),
        ])}
      />,
    );
    // 2 next to Title Card, 1 next to B-Roll.
    expect(html).toMatch(/Title Card[\s\S]*?>\s*2\s*</);
    expect(html).toMatch(/B-Roll[\s\S]*?>\s*1\s*</);
  });

  it('sorts pills by count descending, then alphabetically', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([
          makeRow({ visual_type: 'Animation' }),
          makeRow({ visual_type: 'B-Roll' }),
          makeRow({ visual_type: 'B-Roll' }),
          makeRow({ visual_type: 'B-Roll' }),
          makeRow({ visual_type: 'Title Card' }),
          makeRow({ visual_type: 'Title Card' }),
        ])}
      />,
    );
    const brollIdx = html.indexOf('B-Roll');
    const titleIdx = html.indexOf('Title Card');
    const animIdx = html.indexOf('Animation');
    // B-Roll (3) comes first, then Title Card (2), then Animation (1).
    expect(brollIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(animIdx);
  });

  it('skips visual types with zero rows', () => {
    const html = renderToStaticMarkup(
      <StudioLegend doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).toContain('B-Roll');
    expect(html).not.toContain('Talking Head');
    expect(html).not.toContain('Animation');
  });

  it('ignores rows with empty / whitespace-only visual_type', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([
          makeRow({ visual_type: 'B-Roll' }),
          makeRow({ visual_type: '' }),
          makeRow({ visual_type: '   ' }),
        ])}
      />,
    );
    expect(html).toMatch(/B-Roll[\s\S]*?>\s*1\s*</);
  });
});

describe('StudioLegend — overlay pill', () => {
  it('renders an Overlays pill when any row has overlay_stock_terms', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([
          makeRow({ visual_type: 'B-Roll', overlay_stock_terms: 'businessman handshake' }),
          makeRow({ visual_type: 'B-Roll' }),
        ])}
      />,
    );
    expect(html).toContain('Overlays');
    expect(html).toMatch(/Overlays[\s\S]*?>\s*1\s*</);
  });

  it('omits the Overlays pill when no row has overlay_stock_terms', () => {
    const html = renderToStaticMarkup(
      <StudioLegend doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).not.toContain('Overlays');
  });
});

describe('StudioLegend — empty state', () => {
  it('renders nothing when the doc has no rows at all', () => {
    const html = renderToStaticMarkup(<StudioLegend doc={makeDoc([])} />);
    expect(html).toBe('');
  });

  it('renders nothing when all rows have blank visual_type and no overlays', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([makeRow({ visual_type: '' }), makeRow({ visual_type: '' })])}
      />,
    );
    expect(html).toBe('');
  });
});

describe('StudioLegend — landmark', () => {
  it('uses a section with an accessible label', () => {
    const html = renderToStaticMarkup(
      <StudioLegend doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).toMatch(/<section[^>]*aria-label="Scene type breakdown"/);
  });
});
