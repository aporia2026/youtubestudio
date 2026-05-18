/**
 * Shot-graph editor state — pure logic.
 *
 * Phase 1 of `_plans/2026-05-18-shot-graph-editor.md`. This module is
 * **server-safe** (no React imports); the React adapter lives in
 * `./use-editor-store.tsx`.
 *
 * Phase 1 ships the state shape + a no-op reducer. Phase 2 fills in
 * the actual commands (resize / trim / split / delete / reorder /
 * mute / undo / redo). Keeping the surface stable now means Phase 2
 * is purely additive — new command variants, no API rewrites.
 *
 * The state is intentionally minimal:
 *
 *   doc          — the persisted ProductionDoc (the editor's single
 *                  source of truth for content)
 *   rowImages    — per-row image URLs sourced from the history row
 *                  (Record<number, string>, same shape as
 *                  `user_history.payload.rowImages`)
 *   version      — optimistic-locking version from `user_history`.
 *                  Sent in save requests; server bumps on success,
 *                  returns 409 on stale.
 *   isDirty      — true when the user has applied an unpersisted
 *                  command. Drives the "Save / Saved Xs ago" UI in
 *                  Phase 2.
 *   selection    — currently selected shot index, or null. Drives
 *                  the side panel (Phase 2).
 *   playheadMs   — playhead position in ms from start of timeline.
 *                  Owned by the store so commands like split-at-
 *                  playhead can read it without prop-drilling.
 */
import type { ProductionDoc } from '@/remotion/utils';

export interface EditorState {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  version: number;
  isDirty: boolean;
  selection: number | null;
  playheadMs: number;
}

/**
 * Discriminated union of every editor mutation. Phase 1 has only the
 * setter for the playhead (so the preview can drive selection in
 * future); Phase 2 lands the editing commands.
 *
 *   SET_PLAYHEAD     — playhead reflects the player's current frame
 *   SET_SELECTION    — clicked a shot card
 *   (Phase 2:)
 *   RESIZE_SHOT, TRIM_SHOT, SPLIT_SHOT, DELETE_SHOT,
 *   REORDER_SHOTS, SET_MUTE, REPLACE_MEDIA, ADD_OVERLAY,
 *   SET_TRANSITION, UNDO, REDO, MARK_SAVED, BUMP_VERSION
 */
export type EditorCommand =
  | { type: 'SET_PLAYHEAD'; ms: number }
  | { type: 'SET_SELECTION'; shotIndex: number | null };

export function applyCommand(state: EditorState, cmd: EditorCommand): EditorState {
  switch (cmd.type) {
    case 'SET_PLAYHEAD':
      // Playhead changes are not "edits" — `isDirty` stays put.
      return state.playheadMs === cmd.ms ? state : { ...state, playheadMs: cmd.ms };
    case 'SET_SELECTION':
      return state.selection === cmd.shotIndex ? state : { ...state, selection: cmd.shotIndex };
  }
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
  };
}
