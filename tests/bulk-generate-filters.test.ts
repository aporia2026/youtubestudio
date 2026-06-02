/**
 * Unit tests for the three bulk-generate row filters.
 *
 * User-asked-for (2026-06-02): three separate "Generate all X" bulk
 * actions, each filtering rows by a specific predicate. The filters
 * are pure functions; pin them so a future refactor of the filter
 * rules surfaces the change in a failing test instead of a silent
 * "wait why did I just spend $5 regenerating my title cards" moment.
 */

import { describe, expect, it } from 'vitest';
import {
  computeMissingBaseImages,
  computeMissingVariants,
  computeMissingMotionCollages,
  computeAllEligibleMotionCollages,
} from '@/components/editor/BulkGenerateModal';
import type { ProductionDoc } from '@/remotion/utils';

function row(fields: Partial<ProductionDoc['rows'][number]>): ProductionDoc['rows'][number] {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'Animation',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...fields,
  };
}

function makeDoc(rows: ProductionDoc['rows']): ProductionDoc {
  return {
    title: 'T',
    niche: 'X',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows,
  };
}

describe('computeMissingBaseImages — base rows with no image', () => {
  it('includes Animation row with no variant_index and no rendered image', () => {
    const doc = makeDoc([row({ visual_type: 'Animation' })]);
    expect(computeMissingBaseImages(doc, {}).map(r => r.rowIndex)).toEqual([0]);
  });

  it('includes variant_index 0 (explicit base)', () => {
    const doc = makeDoc([row({ variant_index: 0 })]);
    expect(computeMissingBaseImages(doc, {})).toHaveLength(1);
  });

  it('skips rows that already have an image', () => {
    const doc = makeDoc([row({}), row({})]);
    const rowImages = { 0: 'https://example.com/0.png' };
    expect(computeMissingBaseImages(doc, rowImages).map(r => r.rowIndex)).toEqual([1]);
  });

  it('skips variants (variant_index > 0)', () => {
    const doc = makeDoc([
      row({ variant_index: 0 }), // base, missing
      row({ variant_index: 1 }), // variant
    ]);
    expect(computeMissingBaseImages(doc, {}).map(r => r.rowIndex)).toEqual([0]);
  });

  it('skips Title Card + blank rows', () => {
    const doc = makeDoc([
      row({ visual_type: 'Title Card' }),
      row({ visual_type: 'blank' }),
      row({ visual_type: 'Animation' }),
    ]);
    expect(computeMissingBaseImages(doc, {}).map(r => r.rowIndex)).toEqual([2]);
  });

  it('skips motion-collage rows (own bulk path)', () => {
    const doc = makeDoc([
      row({ shot_kind: 'motion_collage' }),
      row({ visual_type: 'Animation' }),
    ]);
    expect(computeMissingBaseImages(doc, {}).map(r => r.rowIndex)).toEqual([1]);
  });
});

describe('computeMissingVariants — variant rows with no image', () => {
  it('includes only variant_index > 0 with no image', () => {
    const doc = makeDoc([
      row({ variant_index: 0 }),
      row({ variant_index: 1 }),
      row({ variant_index: 2 }),
    ]);
    expect(computeMissingVariants(doc, {}).map(r => r.rowIndex)).toEqual([1, 2]);
  });

  it('skips variants that already have an image', () => {
    const doc = makeDoc([
      row({ variant_index: 1 }),
      row({ variant_index: 2 }),
    ]);
    expect(computeMissingVariants(doc, { 0: 'x' }).map(r => r.rowIndex)).toEqual([1]);
  });

  it('skips bases (variant_index 0 / undefined) entirely', () => {
    const doc = makeDoc([
      row({ variant_index: 0 }),
      row({}),
    ]);
    expect(computeMissingVariants(doc, {})).toHaveLength(0);
  });

  it('skips Title Card + blank rows even when variant_index > 0', () => {
    const doc = makeDoc([
      row({ variant_index: 1, visual_type: 'Title Card' }),
      row({ variant_index: 1, visual_type: 'blank' }),
      row({ variant_index: 1, visual_type: 'Animation' }),
    ]);
    expect(computeMissingVariants(doc, {}).map(r => r.rowIndex)).toEqual([2]);
  });
});

describe('computeMissingMotionCollages — collages without panels', () => {
  it('includes motion_collage rows with no panel URLs (and valid grid + prompts)', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
      }),
    ]);
    expect(computeMissingMotionCollages(doc).map(r => r.rowIndex)).toEqual([0]);
  });

  it('skips collages that already have panels rendered', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
        motion_collage_panel_urls: ['url1', 'url2', 'url3', 'url4'],
      }),
    ]);
    expect(computeMissingMotionCollages(doc)).toHaveLength(0);
  });

  it('skips non-motion-collage rows', () => {
    const doc = makeDoc([
      row({ visual_type: 'Animation' }),
      row({ shot_kind: 'motion_collage', motion_collage_grid: { cols: 2, rows: 2 }, motion_collage_panel_prompts: ['a', 'b', 'c', 'd'] }),
    ]);
    expect(computeMissingMotionCollages(doc).map(r => r.rowIndex)).toEqual([1]);
  });

  it('skips collages with empty / blank panel prompts (need user input first)', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', '', 'c', 'd'],
      }),
    ]);
    expect(computeMissingMotionCollages(doc)).toHaveLength(0);
  });

  it('skips collages with no grid set', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_panel_prompts: ['a', 'b'],
      }),
    ]);
    expect(computeMissingMotionCollages(doc)).toHaveLength(0);
  });

  it('skips collages with no panel prompts', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
      }),
    ]);
    expect(computeMissingMotionCollages(doc)).toHaveLength(0);
  });
});

describe('computeAllEligibleMotionCollages — every motion-collage row regardless of panel state', () => {
  it('includes collages WITH existing panels (unlike computeMissingMotionCollages)', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
        motion_collage_panel_urls: ['u1', 'u2', 'u3', 'u4'],
      }),
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
      }),
    ]);
    expect(computeAllEligibleMotionCollages(doc).map(r => r.rowIndex)).toEqual([0, 1]);
    // Sanity: the "missing" filter only sees row 1.
    expect(computeMissingMotionCollages(doc).map(r => r.rowIndex)).toEqual([1]);
  });

  it('still gates on grid + non-blank prompts (regen can\'t fix data gaps)', () => {
    const doc = makeDoc([
      row({
        shot_kind: 'motion_collage',
        motion_collage_panel_urls: ['u1', 'u2', 'u3', 'u4'],
        // missing grid + prompts
      }),
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', '', 'c', 'd'],
        motion_collage_panel_urls: ['u1', 'u2', 'u3', 'u4'],
      }),
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
        motion_collage_panel_urls: ['u1', 'u2', 'u3', 'u4'],
      }),
    ]);
    expect(computeAllEligibleMotionCollages(doc).map(r => r.rowIndex)).toEqual([2]);
  });

  it('skips non-motion-collage rows entirely', () => {
    const doc = makeDoc([
      row({ visual_type: 'Animation' }),
      row({
        shot_kind: 'motion_collage',
        motion_collage_grid: { cols: 2, rows: 2 },
        motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
      }),
    ]);
    expect(computeAllEligibleMotionCollages(doc).map(r => r.rowIndex)).toEqual([1]);
  });
});
