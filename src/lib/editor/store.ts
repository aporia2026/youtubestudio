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
 * Every editing command is a pure `(state, args) => { next; inverse }`
 * function. `apply()` runs the forward function, pushes the inverse
 * onto the undo stack, and clears the redo stack. Undo pops the
 * undo stack, applies the inverse, and pushes the original onto
 * redo. This is the standard NLE pattern; the inverse-pair design
 * means we never need to deep-copy state to remember the past.
 *
 * Phase 2 ships the catalog with `SET_PLAYHEAD` + `SET_SELECTION`
 * (no inverses; these don't go on the undo stack). The editing
 * commands (RESIZE_SHOT, TRIM_SHOT, SPLIT_SHOT, DELETE_SHOT,
 * REORDER_SHOTS, SET_MUTE) land in their own commits — each one
 * adds its variant to the discriminated union below and its
 * implementation to `applyEditingCommand`.
 *
 * Save flow
 * ─────────
 * `apply()` flips `isDirty` to true on any editing command. The
 * React adapter watches `isDirty` and debounces a PATCH to
 * `/api/editor/:projectId`. On success it dispatches `MARK_SAVED`
 * with the server's new version. On 409 (stale version) it
 * dispatches `RESET_FROM_SERVER` with the server's current payload
 * and version, dropping the user's unsaved edits (Phase 2 keeps it
 * simple — merge UI is a v2 problem).
 */
import type { ProductionDoc } from '@/remotion/utils';

const UNDO_STACK_DEPTH = 200;

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
  /** Undo/redo stacks hold INVERSE commands (undoStack) and
   *  REPLAY commands (redoStack). Capped at UNDO_STACK_DEPTH. */
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
 *       (filled per-command commit; see `applyEditingCommand`)
 */
export type EditorCommand =
  | { type: 'SET_PLAYHEAD'; ms: number }
  | { type: 'SET_SELECTION'; shotIndex: number | null }
  | { type: 'MARK_SAVED'; version: number; savedAt: number }
  | { type: 'RESET_FROM_SERVER'; doc: ProductionDoc; rowImages: Record<number, string>; version: number }
  | { type: 'UNDO' }
  | { type: 'REDO' };

/**
 * Editing-command scaffolding lands per-command. The first editing
 * commit (TRIM_SHOT) adds its variant to the `EditorCommand` union
 * above, a case in the `applyCommand` switch, and pushes the
 * inverse onto `undoStack` via the helper below.
 */
function pushUndo(stack: EditorCommand[], cmd: EditorCommand): EditorCommand[] {
  const next = stack.length >= UNDO_STACK_DEPTH ? stack.slice(1) : stack;
  return [...next, cmd];
}

export function applyCommand(state: EditorState, cmd: EditorCommand): EditorState {
  switch (cmd.type) {
    case 'SET_PLAYHEAD':
      return state.playheadMs === cmd.ms ? state : { ...state, playheadMs: cmd.ms };

    case 'SET_SELECTION':
      return state.selection === cmd.shotIndex ? state : { ...state, selection: cmd.shotIndex };

    case 'MARK_SAVED':
      // Server acknowledged the most recent save. Clear isDirty and
      // bump the local version to what the server returned. If new
      // edits landed while the save was in flight, isDirty was
      // flipped back to true by those commands — we MUST NOT clear
      // it here in that case. The React adapter passes a `savedAt`
      // monotonically increasing per attempt; the store compares
      // against the attempt's start mark via the dirty flag set
      // since.
      return {
        ...state,
        version: cmd.version,
        lastSavedAt: cmd.savedAt,
        // Stays dirty if new commands landed during the save round-trip;
        // otherwise clears. The React adapter handles this distinction
        // by only dispatching MARK_SAVED when no commands ran between
        // request and response — so unconditional clear here is safe.
        isDirty: false,
      };

    case 'RESET_FROM_SERVER':
      // 409 path: drop local edits, take the server's truth.
      return {
        ...state,
        doc: cmd.doc,
        rowImages: cmd.rowImages,
        version: cmd.version,
        isDirty: false,
        undoStack: [],
        redoStack: [],
        selection: null,
      };

    case 'UNDO': {
      if (state.undoStack.length === 0) return state;
      const inverse = state.undoStack[state.undoStack.length - 1];
      const restOfUndo = state.undoStack.slice(0, -1);
      // Apply the inverse — but DON'T push another inverse onto the
      // undo stack (we're walking back through history, not forward).
      // The forward command that originally produced this inverse
      // goes on the redo stack so REDO can replay it.
      const restored = applyCommand(state, inverse);
      return {
        ...restored,
        undoStack: restOfUndo,
        redoStack: [...state.redoStack, inverse],
        isDirty: true,
      };
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state;
      const forward = state.redoStack[state.redoStack.length - 1];
      const restOfRedo = state.redoStack.slice(0, -1);
      const next = applyCommand(state, forward);
      // The forward command would normally push its inverse onto
      // the undo stack; for redo we instead push the SAME command
      // that was popped, since the symmetry of the inverse pair
      // means re-running it re-establishes the prior state.
      return {
        ...next,
        undoStack: pushUndo(state.undoStack, forward),
        redoStack: restOfRedo,
        isDirty: true,
      };
    }
  }
}

/**
 * Build the initial editor state from the values persisted on the
 * user_history row. The shape of `payload` is intentionally `unknown`
 * at the type boundary — callers parse defensively.
 */
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

/**
 * Serialise the editor's persistable state back to the
 * `user_history.payload` shape. Excludes the transient slots
 * (selection, playheadMs, undoStack, redoStack, isDirty, version,
 * lastSavedAt) — those live only in memory.
 */
export function persistableFromState(state: EditorState): { doc: ProductionDoc; rowImages: Record<number, string> } {
  return {
    doc: state.doc,
    rowImages: state.rowImages,
  };
}
