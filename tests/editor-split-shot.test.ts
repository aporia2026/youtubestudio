/**
 * SPLIT_SHOT motion-beat slicing + variant detach tests.
 *
 * Companion to tests/editor-pin-duration.test.ts which covers the
 * duration / pin contract. This file covers the two follow-on
 * behaviors added by `_plans/2026-06-02-shot-split-ui.md`:
 *
 *   1. motion_beats[] sliced by splitAtMs, spanners dropped, second-half
 *      startMs rebased.
 *   2. Variant-group fields cleared on the second half.
 *   3. MERGE_ADJACENT_SHOTS (undo path) restores both fields verbatim
 *      so a SPLIT → UNDO → REDO cycle reproduces the same slice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionBeat, ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  applyCommand,
  initialEditorState,
  type EditorState,
} from '@/lib/editor/store';

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '',
    script_text: '',
    visual_type: '',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    duration_override_ms: 8000,
    ...overrides,
  };
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'Split test',
    niche: 'test',
    total_duration: '60',
    total_words: 100,
    speaking_pace_wpm: 150,
    rows,
  };
}

function makeState(rows: ProductionRow[]): EditorState {
  return initialEditorState({
    doc: makeDoc(rows),
    rowImages: {},
    version: 1,
  });
}

function beat(overrides: Partial<MotionBeat> & { startMs: number; durationMs: number }): MotionBeat {
  return {
    kind: 'label_pop',
    ...overrides,
  };
}

// Silence the per-split info log during tests — we re-enable + spy on
// it in the cases that assert on its shape.
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  infoSpy.mockRestore();
});

// ─── motion_beats[] slicing ──────────────────────────────────────

describe('SPLIT_SHOT — motion_beats slicing', () => {
  it('keeps beats fully before the split on the first half with original startMs', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 500, durationMs: 1000 }),
      beat({ kind: 'mouth_swap', startMs: 1800, durationMs: 800 }),
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toEqual(beats);
    expect(next.doc.rows[1].motion_beats).toBeUndefined();
  });

  it('moves beats fully after the split to the second half with rebased startMs', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 4500, durationMs: 800 }),
      beat({ kind: 'prop_slide', startMs: 6000, durationMs: 500 }),
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toBeUndefined();
    expect(next.doc.rows[1].motion_beats).toEqual([
      { kind: 'label_pop', startMs: 500, durationMs: 800 },
      { kind: 'prop_slide', startMs: 2000, durationMs: 500 },
    ]);
  });

  it('drops beats that span the split — neither half receives them', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'mouth_swap', startMs: 1000, durationMs: 1000 }), // before
      beat({ kind: 'label_pop', startMs: 3800, durationMs: 600 }),   // spans 4000
      beat({ kind: 'prop_slide', startMs: 5000, durationMs: 800 }),  // after
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toEqual([beats[0]]);
    expect(next.doc.rows[1].motion_beats).toEqual([
      { kind: 'prop_slide', startMs: 1000, durationMs: 800 },
    ]);
  });

  it('logs the dropped-beats count via [editor split]', () => {
    infoSpy.mockClear();
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 3800, durationMs: 600 }),
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(infoSpy).toHaveBeenCalledWith(
      '[editor split] applied',
      expect.objectContaining({
        beatsDropped: 1,
        beatsKept: { first: 0, second: 0 },
      }),
    );
  });

  it('boundary: a beat starting exactly at splitAtMs goes to the second half at relative 0', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 4000, durationMs: 600 }),
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toBeUndefined();
    expect(next.doc.rows[1].motion_beats).toEqual([
      { kind: 'label_pop', startMs: 0, durationMs: 600 },
    ]);
  });

  it('boundary: a beat ending exactly at splitAtMs stays on the first half', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 3400, durationMs: 600 }), // ends at 4000
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toEqual(beats);
    expect(next.doc.rows[1].motion_beats).toBeUndefined();
  });

  it('produces undefined motion_beats on both halves when the source row had none', () => {
    const state = makeState([row({ duration_override_ms: 8000 })]);
    expect(state.doc.rows[0].motion_beats).toBeUndefined();
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].motion_beats).toBeUndefined();
    expect(next.doc.rows[1].motion_beats).toBeUndefined();
    // Field literally absent, not an empty array — keeps the JSON compact.
    expect('motion_beats' in next.doc.rows[0]).toBe(false);
    expect('motion_beats' in next.doc.rows[1]).toBe(false);
  });
});

// ─── Variant-group detach ────────────────────────────────────────

describe('SPLIT_SHOT — variant detach', () => {
  it('clears every variant field on the second half; first half keeps them', () => {
    const state = makeState([
      row({
        duration_override_ms: 8000,
        group_id: 'g-1',
        variant_index: 1,
        variant_edit_prompt: 'open mouth',
        variant_base_image_at_generation: 'https://r2.example/base.png',
        variant_derives_from_previous: false,
      }),
    ]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].group_id).toBe('g-1');
    expect(next.doc.rows[0].variant_index).toBe(1);
    expect(next.doc.rows[0].variant_edit_prompt).toBe('open mouth');
    expect(next.doc.rows[1].group_id).toBeUndefined();
    expect(next.doc.rows[1].variant_index).toBeUndefined();
    expect(next.doc.rows[1].variant_edit_prompt).toBeUndefined();
    expect(next.doc.rows[1].variant_base_image_at_generation).toBeUndefined();
    expect(next.doc.rows[1].variant_derives_from_previous).toBeUndefined();
    // Field literally absent — not present-but-undefined.
    expect('group_id' in next.doc.rows[1]).toBe(false);
  });

  it('clears group_variant_chain_default on the second half (base-row field)', () => {
    const state = makeState([
      row({
        duration_override_ms: 8000,
        group_id: 'g-2',
        variant_index: 0,
        group_variant_chain_default: 'chained',
      }),
    ]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].group_variant_chain_default).toBe('chained');
    expect(next.doc.rows[1].group_variant_chain_default).toBeUndefined();
  });

  it('standalone row stays standalone on both halves (no variant fields to clear)', () => {
    const state = makeState([row({ duration_override_ms: 8000 })]);
    const next = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(next.doc.rows[0].group_id).toBeUndefined();
    expect(next.doc.rows[1].group_id).toBeUndefined();
  });

  it('logs variantDetached: true when the source row was in a group', () => {
    infoSpy.mockClear();
    const state = makeState([
      row({ duration_override_ms: 8000, group_id: 'g-3', variant_index: 0 }),
    ]);
    applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    expect(infoSpy).toHaveBeenCalledWith(
      '[editor split] applied',
      expect.objectContaining({ variantDetached: true }),
    );
  });
});

// ─── MERGE_ADJACENT_SHOTS (undo) restores ────────────────────────

describe('SPLIT_SHOT → UNDO → REDO round-trip', () => {
  it('UNDO restores the original motion_beats[] even after a spanning-beat drop', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'mouth_swap', startMs: 1000, durationMs: 1000 }),
      beat({ kind: 'label_pop', startMs: 3800, durationMs: 600 }), // spans split
      beat({ kind: 'prop_slide', startMs: 5000, durationMs: 800 }),
    ];
    const state = makeState([row({ duration_override_ms: 8000, motion_beats: beats })]);
    const split = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    const undone = applyCommand(split, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(1);
    // Critical: the dropped spanning beat is BACK on undo. The inverse
    // captured the pre-split array verbatim.
    expect(undone.doc.rows[0].motion_beats).toEqual(beats);
  });

  it('UNDO restores variant fields on the merged row', () => {
    const state = makeState([
      row({
        duration_override_ms: 8000,
        group_id: 'g-4',
        variant_index: 2,
        variant_edit_prompt: 'tilt head',
      }),
    ]);
    const split = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    const undone = applyCommand(split, { type: 'UNDO' });
    expect(undone.doc.rows[0].group_id).toBe('g-4');
    expect(undone.doc.rows[0].variant_index).toBe(2);
    expect(undone.doc.rows[0].variant_edit_prompt).toBe('tilt head');
  });

  it('UNDO leaves motion_beats absent when the pre-split row had none', () => {
    const state = makeState([row({ duration_override_ms: 8000 })]);
    const split = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    const undone = applyCommand(split, { type: 'UNDO' });
    expect('motion_beats' in undone.doc.rows[0]).toBe(false);
  });

  it('SPLIT → UNDO → REDO produces the exact same split state', () => {
    const beats: MotionBeat[] = [
      beat({ kind: 'label_pop', startMs: 3800, durationMs: 600 }),
      beat({ kind: 'prop_slide', startMs: 5000, durationMs: 800 }),
    ];
    const state = makeState([
      row({ duration_override_ms: 8000, motion_beats: beats, group_id: 'g-5', variant_index: 0 }),
    ]);
    const split = applyCommand(state, { type: 'SPLIT_SHOT', shotIndex: 0, splitAtMs: 4000 });
    const undone = applyCommand(split, { type: 'UNDO' });
    const redone = applyCommand(undone, { type: 'REDO' });
    // Doc shape matches the original split — `edited_at` timestamps
    // are stripped because they're regenerated at apply time and
    // would diff by milliseconds between the two paths.
    const strip = (rows: ProductionRow[]): ProductionRow[] =>
      rows.map((r) => {
        const c = { ...r };
        delete (c as { edited_at?: unknown }).edited_at;
        return c;
      });
    expect(strip(redone.doc.rows)).toEqual(strip(split.doc.rows));
  });
});
