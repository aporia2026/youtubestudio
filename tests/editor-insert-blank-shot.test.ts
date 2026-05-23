/**
 * Tests for INSERT_BLANK_SHOT / REMOVE_INSERTED_SHOT — the seam-based
 * scene insertion reducer pair.
 *
 * Plan: `_plans/2026-05-23-editor-insert-blank-scene-between.md`.
 *
 * Coverage:
 *   - shift mode appends `durationMs` to total length, leaves neighbors alone
 *   - carve mode steals from the chosen neighbor; total length unchanged
 *   - carveFrom 'auto' picks the larger neighbor
 *   - carveFrom 'right'/'left' fall back to the other side when too short
 *   - both neighbors below `2 × EDITOR_MIN_SHOT_MS` ⇒ no-op
 *   - clamp: requested durationMs above maxCarve uses what's available
 *   - insert at index 0, at rows.length, in the middle
 *   - rowImages / rowOverlays / rowVideoClips reindexed by +1
 *   - selection moves to the new row
 *   - isDirty flips true
 *   - undo restores neighbor's prior override (including clear-when-undefined)
 *   - redo reproduces the insert exactly
 *   - REMOVE_INSERTED_SHOT directly: refuses to empty the doc
 */
import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow, RowVideoClipState, RowOverlayRenderState } from '@/remotion/utils';
import {
  applyCommand,
  initialEditorState,
  type EditorState,
} from '@/lib/editor/store';

// ─── Test fixtures ───────────────────────────────────────────────

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
    title: 'Test',
    niche: 'Test',
    total_duration: '0:30',
    total_words: 0,
    speaking_pace_wpm: 150,
    rows,
  };
}

function makeState(args: {
  rows: ProductionRow[];
  rowImages?: Record<number, string>;
  rowOverlays?: Record<number, RowOverlayRenderState>;
  rowVideoClips?: Record<number, RowVideoClipState>;
  selection?: number | null;
}): EditorState {
  const state = initialEditorState({
    doc: makeDoc(args.rows),
    rowImages: args.rowImages ?? {},
    rowOverlays: args.rowOverlays,
    rowVideoClips: args.rowVideoClips,
    version: 1,
  });
  if (args.selection !== undefined) {
    return { ...state, selection: args.selection };
  }
  return state;
}

// ─── Shift mode ──────────────────────────────────────────────────

describe('INSERT_BLANK_SHOT — shift mode', () => {
  it('appends a new blank row in the middle without touching neighbors', () => {
    const state = makeState({
      rows: [
        row({ script_text: 'A', duration_override_ms: 3000 }),
        row({ script_text: 'B', duration_override_ms: 4000 }),
        row({ script_text: 'C', duration_override_ms: 5000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 2,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows).toHaveLength(4);
    expect(next.doc.rows[0].script_text).toBe('A');
    expect(next.doc.rows[1].script_text).toBe('B');
    expect(next.doc.rows[2].script_text).toBe('');
    expect(next.doc.rows[2].visual_type).toBe('blank');
    expect(next.doc.rows[2].duration_override_ms).toBe(2000);
    expect(next.doc.rows[3].script_text).toBe('C');
    // Neighbors untouched.
    expect(next.doc.rows[1].duration_override_ms).toBe(4000);
    expect(next.doc.rows[3].duration_override_ms).toBe(5000);
  });

  it('clamps durationMs below MIN to the floor', () => {
    const state = makeState({ rows: [row(), row()] });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 500,
    });
    expect(next.doc.rows[1].duration_override_ms).toBe(2000);
  });

  it('flips isDirty and moves selection to the inserted row', () => {
    const state = makeState({ rows: [row(), row(), row()], selection: 0 });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.isDirty).toBe(true);
    expect(next.selection).toBe(1);
  });

  it('inserts at index 0 (before first row)', () => {
    const state = makeState({
      rows: [row({ script_text: 'A' }), row({ script_text: 'B' })],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 0,
      mode: 'shift',
      durationMs: 2500,
    });
    expect(next.doc.rows).toHaveLength(3);
    expect(next.doc.rows[0].visual_type).toBe('blank');
    expect(next.doc.rows[1].script_text).toBe('A');
    expect(next.doc.rows[2].script_text).toBe('B');
  });

  it('inserts at rows.length (appends to end)', () => {
    const state = makeState({
      rows: [row({ script_text: 'A' }), row({ script_text: 'B' })],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 2,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows).toHaveLength(3);
    expect(next.doc.rows[2].visual_type).toBe('blank');
  });

  it('out-of-range atIndex is a no-op', () => {
    const state = makeState({ rows: [row(), row()] });
    const tooHigh = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 3,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(tooHigh).toBe(state);
    const negative = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: -1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(negative).toBe(state);
  });
});

// ─── Carve mode ──────────────────────────────────────────────────

describe('INSERT_BLANK_SHOT — carve mode', () => {
  it('default carveFrom auto picks the larger neighbor (right wins)', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 3000 }), // left = 3000
        row({ duration_override_ms: 6000 }), // right = 6000 — larger
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
    });
    // Left untouched, right carved.
    expect(next.doc.rows[0].duration_override_ms).toBe(3000);
    expect(next.doc.rows[1].duration_override_ms).toBe(2000);
    expect(next.doc.rows[2].duration_override_ms).toBe(4000);
  });

  it('default carveFrom auto picks the larger neighbor (left wins)', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 6000 }), // left = 6000 — larger
        row({ duration_override_ms: 3000 }), // right = 3000
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(4000);
    expect(next.doc.rows[1].duration_override_ms).toBe(2000);
    expect(next.doc.rows[2].duration_override_ms).toBe(3000);
  });

  it('carveFrom right explicitly carves from right when adequate', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 6000 }), // left bigger
        row({ duration_override_ms: 5000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(6000);
    expect(next.doc.rows[2].duration_override_ms).toBe(3000);
  });

  it('carveFrom right falls back to left when right is too short', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 5000 }),
        row({ duration_override_ms: 3000 }), // right has 1000 slack < MIN
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    // Fell back to left.
    expect(next.doc.rows[0].duration_override_ms).toBe(3000);
    expect(next.doc.rows[1].duration_override_ms).toBe(2000);
    expect(next.doc.rows[2].duration_override_ms).toBe(3000);
  });

  it('carve at start (atIndex 0) carves from right neighbor (no left)', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 6000 }),
        row({ duration_override_ms: 5000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 0,
      mode: 'carve',
      durationMs: 2000,
    });
    expect(next.doc.rows).toHaveLength(3);
    expect(next.doc.rows[0].visual_type).toBe('blank');
    expect(next.doc.rows[0].duration_override_ms).toBe(2000);
    expect(next.doc.rows[1].duration_override_ms).toBe(4000);
    expect(next.doc.rows[2].duration_override_ms).toBe(5000);
  });

  it('carve at end (atIndex = rows.length) carves from left neighbor (no right)', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 5000 }),
        row({ duration_override_ms: 6000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 2,
      mode: 'carve',
      durationMs: 2000,
    });
    expect(next.doc.rows).toHaveLength(3);
    expect(next.doc.rows[1].duration_override_ms).toBe(4000);
    expect(next.doc.rows[2].duration_override_ms).toBe(2000);
  });

  it('no-op when both neighbors are below 2 × MIN_SHOT_MS', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 3000 }),
        row({ duration_override_ms: 3000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
    });
    expect(next).toBe(state);
  });

  it('clamps carve amount when neighbor cannot give the full request', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 5000 }),
        row({ duration_override_ms: 4500 }), // can only give 2500
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 5000,
      carveFrom: 'right',
    });
    expect(next.doc.rows[1].duration_override_ms).toBe(2500);
    expect(next.doc.rows[2].duration_override_ms).toBe(2000);
  });

  it('uses naturalRowDurationMs for the neighbor when no override is set', () => {
    // Two rows whose effective duration comes from timecodes: 0:00 → 0:10
    // gives row 0 a natural 10000ms duration (well above 2 × MIN).
    const state = makeState({
      rows: [
        row({ timecode: '0:00', duration_override_ms: undefined }),
        row({ timecode: '0:10', duration_override_ms: undefined }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'left',
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(8000);
    expect(next.doc.rows[1].duration_override_ms).toBe(2000);
  });
});

// ─── Reindexing of per-row maps ──────────────────────────────────

describe('INSERT_BLANK_SHOT — reindex per-row maps', () => {
  it('shifts rowImages / rowOverlays / rowVideoClips keys ≥ atIndex up by one', () => {
    const overlay: RowOverlayRenderState = { status: 'ready', url: 'o0' };
    const clip: RowVideoClipState = { status: 'ready', videoUrl: 'v2' };
    const state = makeState({
      rows: [row(), row(), row(), row()],
      rowImages: { 0: 'img0', 2: 'img2', 3: 'img3' },
      rowOverlays: { 0: overlay },
      rowVideoClips: { 2: clip },
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 2,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.rowImages).toEqual({ 0: 'img0', 3: 'img2', 4: 'img3' });
    expect(next.rowOverlays).toEqual({ 0: overlay });
    expect(next.rowVideoClips).toEqual({ 3: clip });
  });
});

// ─── Undo / redo round-trips ─────────────────────────────────────

describe('INSERT_BLANK_SHOT — undo / redo', () => {
  it('shift-mode undo restores the prior doc + maps + selection exactly', () => {
    const overlay: RowOverlayRenderState = { status: 'ready', url: 'o0' };
    const original = makeState({
      rows: [
        row({ script_text: 'A', duration_override_ms: 3000 }),
        row({ script_text: 'B', duration_override_ms: 4000 }),
      ],
      rowImages: { 0: 'img0', 1: 'img1' },
      rowOverlays: { 1: overlay },
      selection: 0,
    });
    const inserted = applyCommand(original, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    const undone = applyCommand(inserted, { type: 'UNDO' });
    expect(undone.doc.rows).toEqual(original.doc.rows);
    expect(undone.rowImages).toEqual(original.rowImages);
    expect(undone.rowOverlays).toEqual(original.rowOverlays);
    expect(undone.undoStack).toHaveLength(0);
    expect(undone.redoStack).toHaveLength(1);
  });

  it('carve-mode undo restores the carved neighbor’s prior override', () => {
    const original = makeState({
      rows: [
        row({ script_text: 'A', duration_override_ms: 3000 }),
        row({ script_text: 'B', duration_override_ms: 6000 }),
      ],
    });
    const inserted = applyCommand(original, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    expect(inserted.doc.rows[2].duration_override_ms).toBe(4000);
    const undone = applyCommand(inserted, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(2);
    expect(undone.doc.rows[1].duration_override_ms).toBe(6000);
  });

  it('carve-mode undo clears the neighbor’s override when it had none before', () => {
    // Neighbor with no explicit override (driven by timecodes).
    const original = makeState({
      rows: [
        row({ duration_override_ms: 3000 }),
        row({ timecode: '0:03', duration_override_ms: undefined }),
        row({ timecode: '0:13', duration_override_ms: undefined }),
      ],
    });
    // Right neighbor (rows[1]) has natural duration 10000ms.
    const inserted = applyCommand(original, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    expect(inserted.doc.rows[2].duration_override_ms).toBe(8000);
    const undone = applyCommand(inserted, { type: 'UNDO' });
    expect(undone.doc.rows[1].duration_override_ms).toBeUndefined();
  });

  it('redo reproduces the insert and re-carves the neighbor', () => {
    const original = makeState({
      rows: [
        row({ duration_override_ms: 3000 }),
        row({ duration_override_ms: 6000 }),
      ],
    });
    const inserted = applyCommand(original, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    const undone = applyCommand(inserted, { type: 'UNDO' });
    const redone = applyCommand(undone, { type: 'REDO' });
    expect(redone.doc.rows).toHaveLength(3);
    expect(redone.doc.rows[1].visual_type).toBe('blank');
    expect(redone.doc.rows[1].duration_override_ms).toBe(2000);
    expect(redone.doc.rows[2].duration_override_ms).toBe(4000);
  });

  it('a new edit clears the redo stack', () => {
    const original = makeState({ rows: [row(), row(), row()] });
    const inserted = applyCommand(original, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    const undone = applyCommand(inserted, { type: 'UNDO' });
    expect(undone.redoStack).toHaveLength(1);
    const reInserted = applyCommand(undone, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 2,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(reInserted.redoStack).toHaveLength(0);
  });
});

// ─── Field preservation on neighbors ─────────────────────────────

describe('INSERT_BLANK_SHOT — field preservation', () => {
  it("preserves the right neighbor's section_title (the new row gets none)", () => {
    const state = makeState({
      rows: [
        row({ script_text: 'A', duration_override_ms: 6000 }),
        row({ script_text: 'B', section_title: 'Body', duration_override_ms: 6000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows[1].section_title).toBeUndefined();
    expect(next.doc.rows[2].section_title).toBe('Body');
  });

  it("preserves the right neighbor's transition_in (now fades from blank row)", () => {
    const state = makeState({
      rows: [
        row({ script_text: 'A', duration_override_ms: 6000 }),
        row({ script_text: 'B', transition_in: 'cross-fade', duration_override_ms: 6000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows[1].transition_in).toBeUndefined();
    expect(next.doc.rows[2].transition_in).toBe('cross-fade');
  });

  it('the new row is stamped edited_at so AI re-gen treats it as user-touched', () => {
    const state = makeState({ rows: [row(), row()] });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows[1].edited_at).toBeDefined();
  });
});

// ─── Selection adjustment ────────────────────────────────────────

describe('INSERT_BLANK_SHOT — selection', () => {
  it('selection always moves to the new row, even when a later row was selected', () => {
    const state = makeState({
      rows: [row(), row(), row(), row()],
      selection: 3,
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.selection).toBe(1);
  });
});

// ─── REMOVE_INSERTED_SHOT selection adjustment ───────────────────

describe('REMOVE_INSERTED_SHOT — selection adjustment', () => {
  it('shifts selection down by 1 when selection was after the removed row', () => {
    const state = makeState({
      rows: [row(), row(), row(), row()],
      selection: 3,
    });
    const next = applyCommand(state, { type: 'REMOVE_INSERTED_SHOT', atIndex: 1 });
    expect(next.selection).toBe(2);
  });

  it('moves selection to the row that occupies the freed slot when selection === atIndex', () => {
    const state = makeState({
      rows: [row(), row(), row()],
      selection: 1,
    });
    const next = applyCommand(state, { type: 'REMOVE_INSERTED_SHOT', atIndex: 1 });
    expect(next.selection).toBe(1);
  });

  it('clamps to last row when atIndex was the last row and selected', () => {
    const state = makeState({
      rows: [row(), row()],
      selection: 1,
    });
    const next = applyCommand(state, { type: 'REMOVE_INSERTED_SHOT', atIndex: 1 });
    expect(next.selection).toBe(0);
  });
});

// ─── Clamping limits ─────────────────────────────────────────────

describe('INSERT_BLANK_SHOT — clamping limits', () => {
  it('clamps durationMs above EDITOR_MAX_SHOT_MS (5 min)', () => {
    const state = makeState({ rows: [row(), row()] });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 10 * 60 * 1000,
    });
    expect(next.doc.rows[1].duration_override_ms).toBe(5 * 60 * 1000);
  });
});

// ─── pin_duration (2026-05-23 architecture) ──────────────────────

describe('INSERT_BLANK_SHOT — pin_duration', () => {
  it('newly inserted blank row has pin_duration: true', () => {
    const state = makeState({ rows: [row(), row()] });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'shift',
      durationMs: 2000,
    });
    expect(next.doc.rows[1].pin_duration).toBe(true);
  });

  it('carve mode pins BOTH the new row AND the carved neighbor', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 6000 }),
        row({ duration_override_ms: 6000 }),
      ],
    });
    const next = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    // New blank row at index 1 — pinned.
    expect(next.doc.rows[1].pin_duration).toBe(true);
    // Carved right neighbor (now at index 2) — also pinned.
    expect(next.doc.rows[2].pin_duration).toBe(true);
    // Left neighbor untouched — still unpinned.
    expect(next.doc.rows[0].pin_duration).toBeUndefined();
  });

  it('undo restores the carved neighbor’s prior pin state exactly', () => {
    const state = makeState({
      rows: [
        row({ duration_override_ms: 6000 }),
        row({ duration_override_ms: 6000 }),
      ],
    });
    const inserted = applyCommand(state, {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 1,
      mode: 'carve',
      durationMs: 2000,
      carveFrom: 'right',
    });
    expect(inserted.doc.rows[2].pin_duration).toBe(true);
    const undone = applyCommand(inserted, { type: 'UNDO' });
    // Neighbor's pin reverts to absent (its pre-carve state).
    expect(undone.doc.rows[1].pin_duration).toBeUndefined();
  });
});

// ─── REMOVE_INSERTED_SHOT direct dispatch ────────────────────────

describe('REMOVE_INSERTED_SHOT — direct dispatch safety', () => {
  it('refuses to empty the doc', () => {
    const state = makeState({ rows: [row()] });
    const next = applyCommand(state, { type: 'REMOVE_INSERTED_SHOT', atIndex: 0 });
    expect(next).toBe(state);
  });

  it('out-of-range atIndex is a no-op', () => {
    const state = makeState({ rows: [row(), row()] });
    const next = applyCommand(state, { type: 'REMOVE_INSERTED_SHOT', atIndex: 5 });
    expect(next).toBe(state);
  });
});
