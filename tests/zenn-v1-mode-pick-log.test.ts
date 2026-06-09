import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  productionDocToVideoConfig,
  type ProductionDoc,
  type ProductionRow,
} from '@/remotion/utils';

// ─── [zenn-v1 mode-pick] observability ──────────────────────────────
//
// PR 5 of the zenn_v1 plan. `productionDocToVideoConfig` is the seam
// where every preview render and every Lambda render goes through, so
// it's the canonical place to surface what mode the LLM picked on
// which rows. The log line is the user's diagnostic for misclassified
// mode picks once they start generating real Zenn docs.

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    script_text: 'hello',
    visual_type: 'ai_image',
    visual_description: 'desc',
    stock_search_terms: '',
    ai_image_prompt: 'prompt',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeZennDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'Zenn mode-pick test',
    niche: 'test',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    style_preset: 'zenn_v1',
    rows,
  } as ProductionDoc;
}

describe('[zenn-v1 mode-pick] log emission', () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  function getModePickCalls() {
    return consoleInfoSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0] === '[zenn-v1 mode-pick]',
    );
  }

  it('fires exactly once on a zenn_v1 doc with mode-picked rows', () => {
    const doc = makeZennDoc([
      row({ timecode: '0:00', zenn_mode: 'stick' }),
      row({ timecode: '0:05', zenn_mode: 'scene' }),
    ]);
    productionDocToVideoConfig(doc, [null, null]);
    expect(getModePickCalls()).toHaveLength(1);
  });

  it('counts stick and scene picks correctly', () => {
    const doc = makeZennDoc([
      row({ timecode: '0:00', zenn_mode: 'stick' }),
      row({ timecode: '0:05', zenn_mode: 'stick' }),
      row({ timecode: '0:10', zenn_mode: 'scene' }),
      row({ timecode: '0:15', zenn_mode: 'scene' }),
      row({ timecode: '0:20', zenn_mode: 'scene' }),
    ]);
    productionDocToVideoConfig(doc, [null, null, null, null, null]);
    const [, payload] = getModePickCalls()[0];
    expect(payload).toMatchObject({
      total_rows: 5,
      rows_with_mode: 5,
      stick_count: 2,
      scene_count: 3,
    });
  });

  it('skips rows whose zenn_mode is unset', () => {
    const doc = makeZennDoc([
      row({ timecode: '0:00', zenn_mode: 'stick' }),
      row({ timecode: '0:05' }), // no mode set
      row({ timecode: '0:10', zenn_mode: 'scene' }),
    ]);
    productionDocToVideoConfig(doc, [null, null, null]);
    const [, payload] = getModePickCalls()[0];
    expect(payload).toMatchObject({
      total_rows: 3,
      rows_with_mode: 2,
      stick_count: 1,
      scene_count: 1,
    });
  });

  it('threads zenn_mode_reason into the sample entries', () => {
    const doc = makeZennDoc([
      row({
        timecode: '0:00',
        zenn_mode: 'stick',
        zenn_mode_reason: 'abstract feeling, no character',
      }),
      row({
        timecode: '0:05',
        zenn_mode: 'scene',
        zenn_mode_reason: 'recurring historical figure in Kalahari',
      }),
    ]);
    productionDocToVideoConfig(doc, [null, null]);
    const [, payload] = getModePickCalls()[0];
    const sample = (payload as { sample: Array<{ rowIndex: number; mode: string; reason?: string }> })
      .sample;
    expect(sample).toEqual([
      { rowIndex: 0, mode: 'stick', reason: 'abstract feeling, no character' },
      { rowIndex: 1, mode: 'scene', reason: 'recurring historical figure in Kalahari' },
    ]);
  });

  it('caps the sample at 20 entries on a long doc', () => {
    // A 200-row doc shouldn't dump 200 entries into a single log line.
    // The count totals stay accurate; the sample is just a preview.
    const longRows: ProductionRow[] = [];
    for (let i = 0; i < 30; i++) {
      longRows.push(
        row({
          timecode: `0:${String(i).padStart(2, '0')}`,
          zenn_mode: i % 2 === 0 ? 'stick' : 'scene',
        }),
      );
    }
    const doc = makeZennDoc(longRows);
    productionDocToVideoConfig(doc, longRows.map(() => null));
    const [, payload] = getModePickCalls()[0];
    expect(payload).toMatchObject({
      total_rows: 30,
      rows_with_mode: 30,
      stick_count: 15,
      scene_count: 15,
    });
    const sample = (payload as { sample: unknown[] }).sample;
    expect(sample).toHaveLength(20);
  });

  it('does not fire on a non-zenn doc', () => {
    const doc = {
      ...makeZennDoc([row({ timecode: '0:00' })]),
      style_preset: 'doodle_explainer_2',
    };
    productionDocToVideoConfig(doc, [null]);
    expect(getModePickCalls()).toHaveLength(0);
  });

  it('does not fire on a zenn_v1 doc whose rows have NO zenn_mode set', () => {
    // The log line should still emit — telling the user "this is a
    // zenn_v1 doc but no rows have picked a mode yet" is itself
    // useful diagnostic information. The counts will be 0.
    const doc = makeZennDoc([
      row({ timecode: '0:00' }),
      row({ timecode: '0:05' }),
    ]);
    productionDocToVideoConfig(doc, [null, null]);
    const calls = getModePickCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      total_rows: 2,
      rows_with_mode: 0,
      stick_count: 0,
      scene_count: 0,
    });
  });
});
