/**
 * Tests for SET_SHOT_TIMING — atomic edit of both edges of a shot.
 *
 * Plan: `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`.
 *
 * Coverage:
 *   - start-only edit carves from left neighbor
 *   - end-only edit carves from right neighbor
 *   - both edges in one command (single undo step)
 *   - clamp at left when neighbor would drop below 2 s
 *   - clamp at right when neighbor would drop below 2 s
 *   - first-shot start-anchored — deltaStart is silently absorbed
 *   - last-shot extension when no right neighbor (shift fallback)
 *   - undo restores both neighbors AND this shot in one step
 *   - redo reproduces the edit
 *   - no-op when requested values match current
 *   - out-of-range shotIndex is a no-op
 *   - shot with no override (natural duration) is correctly read
 */
import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
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

function makeState(rows: ProductionRow[]): EditorState {
  return initialEditorState({
    doc: makeDoc(rows),
    rowImages: {},
    version: 1,
  });
}

// ─── Start-only edits ────────────────────────────────────────────

describe('SET_SHOT_TIMING — start-only', () => {
  it('moving start LEFT shrinks the left neighbor and grows this shot', () => {
    // Initial timing:
    //   shot 0: 0 → 5000
    //   shot 1: 5000 → 10000 (target)
    //   shot 2: 10000 → 15000
    // Move shot 1's start from 5000 to 3000 (left by 2000):
    //   shot 0 shrinks to 3000
    //   shot 1 becomes 3000 → 10000 (dur 7000)
    //   shot 2 unchanged
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 3000,
      endMs: 10000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(3000);
    expect(next.doc.rows[1].duration_override_ms).toBe(7000);
    expect(next.doc.rows[2].duration_override_ms).toBe(5000);
  });

  it('moving start RIGHT grows the left neighbor and shrinks this shot', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 8000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    // Move shot 1's start from 5000 to 8000 (right by 3000):
    //   shot 0 grows to 8000
    //   shot 1 becomes 8000 → 13000 (dur 5000)
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 8000,
      endMs: 13000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(8000);
    expect(next.doc.rows[1].duration_override_ms).toBe(5000);
  });

  it("clamps when moving start would push left neighbor below 2 s", () => {
    const state = makeState([
      row({ duration_override_ms: 3000 }), // can only give 1000ms
      row({ duration_override_ms: 5000 }),
    ]);
    // Try to move shot 1's start LEFT by 2000 (start 3000 → 1000).
    // Left neighbor would drop to 1000 (< MIN). Clamp: give what we
    // can (1000), so start lands on 2000.
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 1000,
      endMs: 8000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(2000);
    // Shot 1 new dur = 8000 - 2000 = 6000.
    expect(next.doc.rows[1].duration_override_ms).toBe(6000);
  });
});

// ─── End-only edits ──────────────────────────────────────────────

describe('SET_SHOT_TIMING — end-only', () => {
  it('moving end RIGHT shrinks the right neighbor and grows this shot', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 8000 }),
    ]);
    // Move shot 1's end from 10000 to 12000:
    //   shot 1 becomes 5000 → 12000 (dur 7000)
    //   shot 2 shrinks from 8000 to 6000
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 5000,
      endMs: 12000,
    });
    expect(next.doc.rows[1].duration_override_ms).toBe(7000);
    expect(next.doc.rows[2].duration_override_ms).toBe(6000);
  });

  it("clamps when moving end would push right neighbor below 2 s", () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 3000 }), // can only give 1000ms
    ]);
    // Move shot 1's end RIGHT by 2000 (end 10000 → 12000).
    // Right neighbor would drop to 1000 — clamp to 2000 (give 1000).
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 5000,
      endMs: 12000,
    });
    expect(next.doc.rows[2].duration_override_ms).toBe(2000);
    // Shot 1's end actually lands on 11000.
    expect(next.doc.rows[1].duration_override_ms).toBe(6000);
  });

  it('last-shot extension grows total project length (shift fallback)', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    // Move last shot's end from 10000 to 14000.
    // No right neighbor; this shot grows by 4000.
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 5000,
      endMs: 14000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(5000);
    expect(next.doc.rows[1].duration_override_ms).toBe(9000);
  });
});

// ─── Both edges in one command ───────────────────────────────────

describe('SET_SHOT_TIMING — both edges atomic', () => {
  it('moves both edges in a single dispatch and a single undo step', () => {
    // Conceptual analogue of the user's screenshot (scene 71 at
    // 5:40-5:42 → 5:38-5:42), using durations within the renderer's
    // [MIN, MAX] = [2s, 5min] bounds so the clamp doesn't reshape
    // long fixtures retroactively.
    //   shot 0: 0     → 8000  (dur 8000)
    //   shot 1: 8000  → 10000 (dur 2000 — the freshly inserted scene)
    //   shot 2: 10000 → 15000
    const state = makeState([
      row({ duration_override_ms: 8000 }),
      row({ duration_override_ms: 2000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    // Move shot 1's left edge back by 2000 + right edge forward by 1000:
    //   shot 0 shrinks to 6000
    //   shot 1 becomes 6000 → 11000 (dur 5000)
    //   shot 2 shrinks to 4000
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 6000,
      endMs: 11000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(6000);
    expect(next.doc.rows[1].duration_override_ms).toBe(5000);
    expect(next.doc.rows[2].duration_override_ms).toBe(4000);
    // ONE undo step reverses everything (both neighbors + this shot).
    expect(next.undoStack).toHaveLength(1);
  });
});

// ─── First-shot start-anchored ───────────────────────────────────

describe('SET_SHOT_TIMING — first shot', () => {
  it('silently absorbs requested deltaStart (first shot start is anchored at 0)', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    // Try to move shot 0's start to 3000 (impossible; no left neighbor).
    // End moves from 5000 to 7000 — right neighbor shrinks by 2000.
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 0,
      startMs: 3000,
      endMs: 7000,
    });
    // Shot 0 stays at 7000 long, starting at 0.
    expect(next.doc.rows[0].duration_override_ms).toBe(7000);
    expect(next.doc.rows[1].duration_override_ms).toBe(3000);
  });
});

// ─── Undo / redo ─────────────────────────────────────────────────

describe('SET_SHOT_TIMING — undo / redo', () => {
  it('undo restores both neighbors AND this shot in one step', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 3000,
      endMs: 12000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(3000);
    expect(next.doc.rows[1].duration_override_ms).toBe(9000);
    expect(next.doc.rows[2].duration_override_ms).toBe(3000);
    const undone = applyCommand(next, { type: 'UNDO' });
    expect(undone.doc.rows[0].duration_override_ms).toBe(5000);
    expect(undone.doc.rows[1].duration_override_ms).toBe(5000);
    expect(undone.doc.rows[2].duration_override_ms).toBe(5000);
    expect(undone.undoStack).toHaveLength(0);
    expect(undone.redoStack).toHaveLength(1);
  });

  it('redo re-applies the edit', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 3000,
      endMs: 12000,
    });
    const undone = applyCommand(next, { type: 'UNDO' });
    const redone = applyCommand(undone, { type: 'REDO' });
    expect(redone.doc.rows[0].duration_override_ms).toBe(3000);
    expect(redone.doc.rows[1].duration_override_ms).toBe(9000);
    expect(redone.doc.rows[2].duration_override_ms).toBe(3000);
  });
});

// ─── No-ops / validation ─────────────────────────────────────────

describe('SET_SHOT_TIMING — no-ops', () => {
  it('out-of-range shotIndex is a no-op', () => {
    const state = makeState([row(), row()]);
    const tooHigh = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 5,
      startMs: 0,
      endMs: 5000,
    });
    expect(tooHigh).toBe(state);
  });

  it('requesting current timing is a no-op', () => {
    const state = makeState([
      row({ duration_override_ms: 5000 }),
      row({ duration_override_ms: 5000 }),
    ]);
    // Shot 1 is currently 5000-10000.
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 5000,
      endMs: 10000,
    });
    expect(next).toBe(state);
  });
});

// ─── Natural-duration neighbors ──────────────────────────────────

describe('SET_SHOT_TIMING — natural duration', () => {
  it('reads neighbor effective duration from timecode when no override is set', () => {
    // Shot 0 has no override; timecode-derived natural = 10000ms
    // (from 0:00 to 0:10).
    const state = makeState([
      row({ timecode: '0:00', duration_override_ms: undefined }),
      row({ timecode: '0:10', duration_override_ms: 5000 }),
    ]);
    // Move shot 1's start from 10000 to 8000 — carve 2000 from shot 0.
    const next = applyCommand(state, {
      type: 'SET_SHOT_TIMING',
      shotIndex: 1,
      startMs: 8000,
      endMs: 15000,
    });
    expect(next.doc.rows[0].duration_override_ms).toBe(8000);
    expect(next.doc.rows[1].duration_override_ms).toBe(7000);
  });
});
