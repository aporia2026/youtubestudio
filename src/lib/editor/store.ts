/**
 * Shot-graph editor state — pure logic.
 *
 * Phase 1 of `_plans/2026-05-18-shot-graph-editor.md` defined the
 * shape; Phase 2 adds the editing-command catalog + undo/redo stacks.
 * This module is **server-safe** (no React imports); the React
 * adapter lives in `./use-editor-store.tsx`.
 *
 * Command philosophy
 * ──────────────────
 * Two layers:
 *
 *   `applyMutation(state, cmd)` — pure data transform. Returns the
 *     post-mutation state PLUS the inverse command (the one that
 *     would undo this change, computed from the pre-state). No
 *     history bookkeeping. Returns `null` when the command is a
 *     no-op for this state.
 *
 *   `applyCommand(state, cmd)` — public reducer. Handles history
 *     bookkeeping: for editing commands, pushes the inverse onto
 *     undoStack and clears redoStack; for UNDO, pops the top of
 *     undoStack, applies it via applyMutation, pushes the
 *     auto-computed forward onto redoStack; symmetric for REDO.
 *
 * The split keeps the history logic in ONE place (the UNDO/REDO
 * branches), so editing commands can't accidentally smuggle the
 * wrong entry onto a stack.
 *
 * Save flow
 * ─────────
 * `apply()` flips `isDirty` to true on any editing command. The
 * React adapter watches `isDirty` and debounces a PATCH to
 * `/api/editor/:projectId`. On success it dispatches `MARK_SAVED`
 * with the server's new version. On 409 (stale version) it
 * dispatches `RESET_FROM_SERVER` with the server's current payload
 * and version, dropping the user's unsaved edits.
 */
import type { ProductionDoc } from '@/remotion/utils';

const UNDO_STACK_DEPTH = 200;

/** Minimum on-screen duration for any shot, in ms. Mirrors the
 *  renderer's `DEFAULT_MIN_SCENE_MS` floor — a resize below this is
 *  clamped, not rejected, so the drag pointer-events code can clamp
 *  on the fly without bailing out of the drag. */
export const EDITOR_MIN_SHOT_MS = 2000;
/** Hard cap on shot duration. 5 minutes is generous for any single
 *  scene; protects against a runaway pointer drag from extending a
 *  shot into the next century. */
export const EDITOR_MAX_SHOT_MS = 5 * 60 * 1000;

export interface EditorState {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  version: number;
  /** True from the moment an editing command runs until the save
   *  endpoint acknowledges. Drives the toolbar's "Saved · Saving · …"
   *  affordance. */
  isDirty: boolean;
  selection: number | null;
  playheadMs: number;
  /** Wall-clock ms of the last successful save. UI renders "Saved 4s
   *  ago" relative to `Date.now()`. Null until first save. */
  lastSavedAt: number | null;
  /** History stacks. undoStack stores INVERSE commands so popping
   *  one and applying it walks backwards. redoStack stores FORWARD
   *  commands so popping one and applying it walks forward again.
   *  Both capped at UNDO_STACK_DEPTH. */
  undoStack: EditorCommand[];
  redoStack: EditorCommand[];
}

/**
 * Discriminated union of every editor mutation. Categories:
 *
 *   – non-editing (don't dirty / don't go on undo stack):
 *       SET_PLAYHEAD, SET_SELECTION
 *   – save lifecycle (don't dirty / don't go on undo stack):
 *       MARK_SAVED, RESET_FROM_SERVER
 *   – history navigation:
 *       UNDO, REDO
 *   – editing (dirty + push inverse to undo):
 *       RESIZE_SHOT, SPLIT_SHOT, MERGE_ADJACENT_SHOTS
 *       (more land per-command)
 */
export type EditorCommand =
  | { type: 'SET_PLAYHEAD'; ms: number }
  | { type: 'SET_SELECTION'; shotIndex: number | null }
  | { type: 'MARK_SAVED'; version: number; savedAt: number }
  | { type: 'RESET_FROM_SERVER'; doc: ProductionDoc; rowImages: Record<number, string>; version: number }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESIZE_SHOT'; shotIndex: number; durationMs: number }
  | { type: 'SPLIT_SHOT'; shotIndex: number; splitAtMs: number }
  // MERGE_ADJACENT_SHOTS exists only as the inverse of SPLIT_SHOT.
  // Users never dispatch it directly; the reducer emits it when
  // building an undo entry.
  | { type: 'MERGE_ADJACENT_SHOTS'; shotIndex: number; restoredDurationOverrideMs: number | null };

/** Discriminator: editing commands push to the undo stack; non-
 *  editing commands (selection, playhead, save lifecycle, undo/redo
 *  themselves) do not. */
function isEditingCommand(cmd: EditorCommand): boolean {
  switch (cmd.type) {
    case 'RESIZE_SHOT':
    case 'SPLIT_SHOT':
    case 'MERGE_ADJACENT_SHOTS':
      return true;
    default:
      return false;
  }
}

function pushUndo(stack: EditorCommand[], cmd: EditorCommand): EditorCommand[] {
  const next = stack.length >= UNDO_STACK_DEPTH ? stack.slice(1) : stack;
  return [...next, cmd];
}

// ─── Pure-data mutation layer ───────────────────────────────────────
//
// Each editing command implements `applyMutation`, returning the new
// state AND the inverse command. Non-editing commands return `null`
// for `inverse` so the caller skips history bookkeeping.

interface MutationResult {
  /** The post-mutation state. Always populated. Identical reference
   *  to `state` if the mutation is a no-op for this input. */
  next: EditorState;
  /** The inverse — what to apply to undo this change. Only populated
   *  for editing commands. `null` for non-editing commands AND for
   *  editing commands that no-op'd. */
  inverse: EditorCommand | null;
}

function applyMutation(state: EditorState, cmd: EditorCommand): MutationResult {
  switch (cmd.type) {
    case 'SET_PLAYHEAD':
      return {
        next: state.playheadMs === cmd.ms ? state : { ...state, playheadMs: cmd.ms },
        inverse: null,
      };

    case 'SET_SELECTION':
      return {
        next:
          state.selection === cmd.shotIndex
            ? state
            : { ...state, selection: cmd.shotIndex },
        inverse: null,
      };

    case 'MARK_SAVED':
      return {
        next: {
          ...state,
          version: cmd.version,
          lastSavedAt: cmd.savedAt,
          isDirty: false,
        },
        inverse: null,
      };

    case 'RESET_FROM_SERVER':
      return {
        next: {
          ...state,
          doc: cmd.doc,
          rowImages: cmd.rowImages,
          version: cmd.version,
          isDirty: false,
          undoStack: [],
          redoStack: [],
          selection: null,
        },
        inverse: null,
      };

    case 'UNDO':
    case 'REDO':
      // Handled in `applyCommand` — this branch can't actually fire
      // because `applyCommand` short-circuits before calling
      // `applyMutation` for UNDO / REDO. Keep the case so the
      // switch is exhaustive.
      return { next: state, inverse: null };

    case 'RESIZE_SHOT': {
      const { shotIndex, durationMs } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const clampedMs = Math.min(
        EDITOR_MAX_SHOT_MS,
        Math.max(EDITOR_MIN_SHOT_MS, Math.round(durationMs)),
      );
      const row = state.doc.rows[shotIndex];
      const prevDurationMs = row.duration_override_ms;
      if (prevDurationMs === clampedMs) {
        return { next: state, inverse: null };
      }
      // The forward command is what got us here; the inverse takes
      // us back. If the pre-edit row had no override, we synthesise
      // an inverse that restores the natural (timecode-derived)
      // duration — visually identical to "field absent."
      const inverse: EditorCommand = {
        type: 'RESIZE_SHOT',
        shotIndex,
        durationMs:
          typeof prevDurationMs === 'number'
            ? prevDurationMs
            : naturalRowDurationMs(state.doc, shotIndex),
      };
      const nextRow = {
        ...row,
        duration_override_ms: clampedMs,
        edited_at: new Date().toISOString(),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SPLIT_SHOT': {
      const { shotIndex, splitAtMs } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const effectiveDurationMs =
        typeof row.duration_override_ms === 'number'
          ? row.duration_override_ms
          : naturalRowDurationMs(state.doc, shotIndex);
      const firstHalfMs = Math.round(splitAtMs);
      const secondHalfMs = effectiveDurationMs - firstHalfMs;
      if (firstHalfMs < EDITOR_MIN_SHOT_MS || secondHalfMs < EDITOR_MIN_SHOT_MS) {
        console.warn('[editor store] split rejected — would produce shot below min duration', {
          shotIndex,
          firstHalfMs,
          secondHalfMs,
          min: EDITOR_MIN_SHOT_MS,
        });
        return { next: state, inverse: null };
      }
      const stamp = new Date().toISOString();
      const firstHalf = { ...row, duration_override_ms: firstHalfMs, edited_at: stamp };
      // Structural clone with shifted-out duration. Same visual
      // content; the user diverges fields after the split if they
      // want.
      const secondHalf = { ...row, duration_override_ms: secondHalfMs, edited_at: stamp };
      const nextRows = [
        ...state.doc.rows.slice(0, shotIndex),
        firstHalf,
        secondHalf,
        ...state.doc.rows.slice(shotIndex + 1),
      ];
      const inverse: EditorCommand = {
        type: 'MERGE_ADJACENT_SHOTS',
        shotIndex,
        restoredDurationOverrideMs: row.duration_override_ms ?? null,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
          selection: shotIndex,
        },
        inverse,
      };
    }

    case 'MERGE_ADJACENT_SHOTS': {
      const { shotIndex, restoredDurationOverrideMs } = cmd;
      if (shotIndex < 0 || shotIndex + 1 >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      // Capture the about-to-be-merged first half's effective
      // duration BEFORE mutating — that's the splitAtMs the
      // inverse SPLIT will need to reproduce this state.
      const target = state.doc.rows[shotIndex];
      const splitAtMs =
        typeof target.duration_override_ms === 'number'
          ? target.duration_override_ms
          : naturalRowDurationMs(state.doc, shotIndex);
      const restored = {
        ...target,
        duration_override_ms: restoredDurationOverrideMs ?? undefined,
      };
      const nextRows = [
        ...state.doc.rows.slice(0, shotIndex),
        restored,
        ...state.doc.rows.slice(shotIndex + 2),
      ];
      const inverse: EditorCommand = { type: 'SPLIT_SHOT', shotIndex, splitAtMs };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
          selection: shotIndex,
        },
        inverse,
      };
    }
  }
}

// ─── Public reducer with history bookkeeping ────────────────────────

export function applyCommand(state: EditorState, cmd: EditorCommand): EditorState {
  // UNDO: pop top of undoStack, apply it, take the resulting
  // mutation's auto-computed `inverse` (= the forward we just
  // walked back through) and push that onto redoStack.
  if (cmd.type === 'UNDO') {
    if (state.undoStack.length === 0) return state;
    const top = state.undoStack[state.undoStack.length - 1];
    const restOfUndo = state.undoStack.slice(0, -1);
    const { next, inverse } = applyMutation(state, top);
    return {
      ...next,
      undoStack: restOfUndo,
      // `inverse` here is the inverse-of-the-inverse-we-just-applied,
      // i.e. the original forward command. That's exactly what REDO
      // wants on its stack.
      redoStack: inverse ? [...state.redoStack, inverse] : state.redoStack,
    };
  }

  // REDO: pop top of redoStack, apply it, push its auto-computed
  // inverse onto undoStack (so a subsequent UNDO walks back).
  if (cmd.type === 'REDO') {
    if (state.redoStack.length === 0) return state;
    const top = state.redoStack[state.redoStack.length - 1];
    const restOfRedo = state.redoStack.slice(0, -1);
    const { next, inverse } = applyMutation(state, top);
    return {
      ...next,
      redoStack: restOfRedo,
      undoStack: inverse ? pushUndo(state.undoStack, inverse) : state.undoStack,
    };
  }

  // Everything else: apply the mutation. For editing commands push
  // the inverse onto undoStack and clear redoStack (a new edit
  // invalidates any pending redo path).
  const { next, inverse } = applyMutation(state, cmd);
  if (!isEditingCommand(cmd) || !inverse) {
    return next;
  }
  return {
    ...next,
    undoStack: pushUndo(state.undoStack, inverse),
    redoStack: [],
  };
}

/**
 * Compute the natural (pre-editor) duration in ms for a row from its
 * timecode + the next row's timecode. Used to synthesise an inverse
 * for the first edit on a row that previously had no override.
 *
 * Falls back to `EDITOR_MIN_SHOT_MS` for the final row when there's
 * no next-row timecode to subtract against — preserves a sensible
 * undo target without parsing `total_duration`.
 */
function naturalRowDurationMs(doc: ProductionDoc, index: number): number {
  const start = parseTimecodeMs(doc.rows[index]?.timecode);
  if (start === null) return EDITOR_MIN_SHOT_MS;
  const next = doc.rows[index + 1];
  if (!next) return EDITOR_MIN_SHOT_MS;
  const end = parseTimecodeMs(next.timecode);
  if (end === null || end <= start) return EDITOR_MIN_SHOT_MS;
  return end - start;
}

function parseTimecodeMs(tc: string | undefined): number | null {
  if (!tc) return null;
  // Timecodes in this codebase are formatted as "M:SS" or "MM:SS" —
  // sometimes as ranges ("M:SS - M:SS"). Read the leading token.
  const m = tc.trim().match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const minutes = parseInt(m[1], 10);
  const seconds = parseInt(m[2], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return (minutes * 60 + seconds) * 1000;
}

/**
 * Compute the absolute startMs of each row by walking the doc's
 * rows and summing effective durations. Used by callers that need
 * to map an absolute playhead position to a (shotIndex, offset)
 * pair — most notably the "split at playhead" path.
 */
export function rowStartTimesMs(doc: ProductionDoc): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (let i = 0; i < doc.rows.length; i++) {
    out.push(cursor);
    const row = doc.rows[i];
    const duration =
      typeof row.duration_override_ms === 'number'
        ? row.duration_override_ms
        : naturalRowDurationMs(doc, i);
    cursor += duration;
  }
  return out;
}

/** Build the initial editor state from the values persisted on the
 *  user_history row. The shape of `payload` is intentionally `unknown`
 *  at the type boundary — callers parse defensively. */
export function initialEditorState(args: {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  version: number;
}): EditorState {
  return {
    doc: args.doc,
    rowImages: args.rowImages,
    version: args.version,
    isDirty: false,
    selection: null,
    playheadMs: 0,
    lastSavedAt: null,
    undoStack: [],
    redoStack: [],
  };
}

/** Serialise the editor's persistable state back to the
 *  `user_history.payload` shape. Excludes the transient slots. */
export function persistableFromState(state: EditorState): { doc: ProductionDoc; rowImages: Record<number, string> } {
  return {
    doc: state.doc,
    rowImages: state.rowImages,
  };
}
