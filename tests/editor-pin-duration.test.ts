/**
 * Pin-duration architecture tests — RESIZE_SHOT, SPLIT_SHOT,
 * MERGE_ADJACENT_SHOTS, PATCH_ROW with duration.
 *
 * Plan: `_plans/2026-05-23-editor-pin-duration-architecture.md`.
 *
 * Coverage focuses on the cross-action contract:
 *   - Forward user actions set `pin_duration: true` on touched rows
 *   - Inverse paths restore the exact prior pin state (including
 *     undefined → undefined for legacy unpinned rows)
 *   - PATCH_ROW only pins when the patch actually touches duration
 */
import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
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
    duration_override_ms: 5000,
    ...overrides,
  };
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'Pin test',
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

// ─── RESIZE_SHOT (trailing-edge drag) ────────────────────────────

describe('RESIZE_SHOT — pin_duration', () => {
  it('sets pin_duration: true on resize (forward path)', () => {
    const state = makeState([row({ duration_override_ms: 4000 }), row()]);
    expect(state.doc.rows[0].pin_duration).toBeUndefined();
    const next = applyCommand(state, {
      type: 'RESIZE_SHOT',
      shotIndex: 0,
      durationMs: 6000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(6000);
    expect(next.doc.rows[0].pin_duration).toBe(true);
  });

  it('undo restores prior pin_duration: undefined exactly', () => {
    const state = makeState([row({ duration_override_ms: 4000 }), row()]);
    const resized = applyCommand(state, {
      type: 'RESIZE_SHOT',
      shotIndex: 0,
      durationMs: 6000,
    });
    const undone = applyCommand(resized, { type: 'UNDO' });
    expect(undone.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('undo preserves pin_duration: true when prior state was pinned', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true }),
      row(),
    ]);
    const resized = applyCommand(state, {
      type: 'RESIZE_SHOT',
      shotIndex: 0,
      durationMs: 6000,
    });
    const undone = applyCommand(resized, { type: 'UNDO' });
    expect(undone.doc.rows[0].pin_duration).toBe(true);
  });

  it('is a no-op when the duration AND pin state both already match', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true }),
    ]);
    const next = applyCommand(state, {
      type: 'RESIZE_SHOT',
      shotIndex: 0,
      durationMs: 4000,
    });
    expect(next).toBe(state);
  });

  it('runs (not a no-op) when duration matches but pin is currently unset', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    const next = applyCommand(state, {
      type: 'RESIZE_SHOT',
      shotIndex: 0,
      durationMs: 4000,
    });
    expect(next.doc.rows[0].pin_duration).toBe(true);
    expect(next).not.toBe(state);
  });
});

// ─── SPLIT_SHOT / MERGE_ADJACENT_SHOTS ───────────────────────────

describe('SPLIT_SHOT — pin_duration', () => {
  it('pins both halves on split', () => {
    const state = makeState([row({ duration_override_ms: 8000 })]);
    const next = applyCommand(state, {
      type: 'SPLIT_SHOT',
      shotIndex: 0,
      splitAtMs: 4000,
    });
    expect(next.doc.rows).toHaveLength(2);
    expect(next.doc.rows[0].pin_duration).toBe(true);
    expect(next.doc.rows[1].pin_duration).toBe(true);
  });

  it('undo (MERGE_ADJACENT_SHOTS) restores prior pin state on the merged row', () => {
    const state = makeState([row({ duration_override_ms: 8000 })]);
    const split = applyCommand(state, {
      type: 'SPLIT_SHOT',
      shotIndex: 0,
      splitAtMs: 4000,
    });
    const undone = applyCommand(split, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(1);
    // Pre-split row had undefined pin; merge restores it.
    expect(undone.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('undo preserves pin: true when the pre-split row was already pinned', () => {
    const state = makeState([
      row({ duration_override_ms: 8000, pin_duration: true }),
    ]);
    const split = applyCommand(state, {
      type: 'SPLIT_SHOT',
      shotIndex: 0,
      splitAtMs: 4000,
    });
    const undone = applyCommand(split, { type: 'UNDO' });
    expect(undone.doc.rows[0].pin_duration).toBe(true);
  });
});

// ─── RESET_SHOT_TIMING ──────────────────────────────────────────

describe('RESET_SHOT_TIMING — clears duration override AND pin', () => {
  it('clears both fields on a pinned row with an override', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true }),
    ]);
    const next = applyCommand(state, { type: 'RESET_SHOT_TIMING', shotIndex: 0 });
    expect(next.doc.rows[0].duration_override_ms).toBeUndefined();
    expect(next.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('is a no-op on a legacy unpinned row with NO override', () => {
    const state = makeState([row({ duration_override_ms: undefined })]);
    // explicitly strip the test fixture's default 5000 ms
    const stripped = {
      ...state,
      doc: {
        ...state.doc,
        rows: state.doc.rows.map((r) => {
          const c = { ...r };
          delete (c as { duration_override_ms?: number }).duration_override_ms;
          return c;
        }),
      },
    };
    const next = applyCommand(stripped, { type: 'RESET_SHOT_TIMING', shotIndex: 0 });
    expect(next).toBe(stripped);
  });

  it('clears a legacy override-without-pin row (frees stuck override)', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    expect(state.doc.rows[0].pin_duration).toBeUndefined();
    const next = applyCommand(state, { type: 'RESET_SHOT_TIMING', shotIndex: 0 });
    expect(next.doc.rows[0].duration_override_ms).toBeUndefined();
    expect(next.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('undo restores BOTH duration AND pin exactly', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true }),
    ]);
    const reset = applyCommand(state, { type: 'RESET_SHOT_TIMING', shotIndex: 0 });
    const undone = applyCommand(reset, { type: 'UNDO' });
    expect(undone.doc.rows[0].duration_override_ms).toBe(4000);
    expect(undone.doc.rows[0].pin_duration).toBe(true);
  });

  it('undo restores pin: undefined when the prior state was legacy', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    const reset = applyCommand(state, { type: 'RESET_SHOT_TIMING', shotIndex: 0 });
    const undone = applyCommand(reset, { type: 'UNDO' });
    expect(undone.doc.rows[0].pin_duration).toBeUndefined();
    expect(undone.doc.rows[0].duration_override_ms).toBe(4000);
  });
});

// ─── PATCH_ROW with duration_override_ms ─────────────────────────

describe('PATCH_ROW — pin_duration interaction', () => {
  it('pins when the patch sets a new duration_override_ms', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    const next = applyCommand(state, {
      type: 'PATCH_ROW',
      rowIndex: 0,
      patch: { duration_override_ms: 7000 },
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(7000);
    expect(next.doc.rows[0].pin_duration).toBe(true);
  });

  it('UNPINS when the patch clears duration_override_ms (undefined)', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true }),
    ]);
    const next = applyCommand(state, {
      type: 'PATCH_ROW',
      rowIndex: 0,
      patch: { duration_override_ms: undefined },
    });
    expect(next.doc.rows[0].duration_override_ms).toBeUndefined();
    expect(next.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('does NOT touch pin_duration when the patch is unrelated', () => {
    const state = makeState([
      row({ duration_override_ms: 4000, pin_duration: true, script_text: 'A' }),
    ]);
    const next = applyCommand(state, {
      type: 'PATCH_ROW',
      rowIndex: 0,
      patch: { script_text: 'B' },
    });
    expect(next.doc.rows[0].script_text).toBe('B');
    expect(next.doc.rows[0].pin_duration).toBe(true);
  });

  it('respects an explicit pin_duration in the patch (caller in control)', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    const next = applyCommand(state, {
      type: 'PATCH_ROW',
      rowIndex: 0,
      patch: { duration_override_ms: 6000, pin_duration: false },
    });
    // Caller said pin: false explicitly; honor it.
    expect(next.doc.rows[0].duration_override_ms).toBe(6000);
    expect(next.doc.rows[0].pin_duration).toBe(false);
  });

  it('undo restores prior pin state after a duration-touching patch', () => {
    const state = makeState([row({ duration_override_ms: 4000 })]);
    const patched = applyCommand(state, {
      type: 'PATCH_ROW',
      rowIndex: 0,
      patch: { duration_override_ms: 7000 },
    });
    const undone = applyCommand(patched, { type: 'UNDO' });
    expect(undone.doc.rows[0].pin_duration).toBeUndefined();
    expect(undone.doc.rows[0].duration_override_ms).toBe(4000);
  });
});
