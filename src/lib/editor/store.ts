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
import { stampEditedAt } from './edited-at';

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
  /** Voiceover MP3 URL passed through to productionDocToVideoConfig
   *  so the Remotion preview includes audio. Read from the saved
   *  payload on mount; persisted back on every save so the round-trip
   *  preserves it even when the editor doesn't change it. Future
   *  audio-retiming work will dispatch commands against this slot. */
  voiceoverUrl: string | undefined;
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
  | {
      type: 'RESET_FROM_SERVER';
      doc: ProductionDoc;
      rowImages: Record<number, string>;
      voiceoverUrl?: string;
      version: number;
    }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESIZE_SHOT'; shotIndex: number; durationMs: number }
  | { type: 'SPLIT_SHOT'; shotIndex: number; splitAtMs: number }
  // MERGE_ADJACENT_SHOTS exists only as the inverse of SPLIT_SHOT.
  // Users never dispatch it directly; the reducer emits it when
  // building an undo entry.
  | { type: 'MERGE_ADJACENT_SHOTS'; shotIndex: number; restoredDurationOverrideMs: number | null }
  | { type: 'DELETE_SHOT'; shotIndex: number; mode: 'ripple' | 'blank' }
  // Toggle a shot's `muted` flag. Self-inverse — applying twice
  // returns to the original state, so the inverse is the same
  // command type with the prior value as the new value.
  | { type: 'SET_MUTE'; shotIndex: number; muted: boolean }
  // Move a row from one position to another. fromIndex and toIndex
  // are both interpreted against the array BEFORE the move (the
  // typical drag-end semantics in dnd-kit). Self-inverse with the
  // indices swapped.
  | { type: 'REORDER_SHOTS'; fromIndex: number; toIndex: number }
  // Replace a shot's image-state URL (the still rendered by the
  // BRoll scene). Pass `null` to clear. Lives outside the doc row
  // shape because that's where it already lives in `rowImages`.
  | { type: 'SET_ROW_IMAGE'; shotIndex: number; url: string | null }
  // Edit a shot's voiceover script text (also drives caption display
  // in Phase 4 since captions are derived from script_text). Persists
  // on `row.script_text`. Inverse stores the prior text.
  | { type: 'SET_ROW_SCRIPT'; shotIndex: number; text: string }
  // Replace a shot's source video clip (the override read by
  // productionDocToVideoConfig over the auto-pipeline's
  // `rowVideoClips`). Pass `null` for both fields to clear.
  | {
      type: 'SET_ROW_VIDEO';
      shotIndex: number;
      url: string | null;
      durationSeconds: number | null;
    }
  // Set head and/or tail trim on a shot. Either value may be omitted
  // to leave the current setting; pass `null` to clear an existing
  // trim. The reducer captures the prior values for the inverse.
  | {
      type: 'TRIM_SHOT';
      shotIndex: number;
      trimStartMs?: number | null;
      trimEndMs?: number | null;
    }
  // RESTORE_ROW exists only as the inverse of DELETE_SHOT. Carries
  // the full pre-delete row (for content) + the prior rowImages[i]
  // URL (so blanking out the image-state slot can be undone). Mode
  // echoes the original delete's mode: 'insert' re-inserts the row
  // (ripple inverse); 'replace' writes the row back over the
  // existing blanked slot (blank inverse).
  | {
      type: 'RESTORE_ROW';
      atIndex: number;
      row: ProductionDoc['rows'][number];
      rowImageUrl: string | null;
      mode: 'insert' | 'replace';
    };

/** Discriminator: editing commands push to the undo stack; non-
 *  editing commands (selection, playhead, save lifecycle, undo/redo
 *  themselves) do not. */
function isEditingCommand(cmd: EditorCommand): boolean {
  switch (cmd.type) {
    case 'RESIZE_SHOT':
    case 'SPLIT_SHOT':
    case 'MERGE_ADJACENT_SHOTS':
    case 'DELETE_SHOT':
    case 'RESTORE_ROW':
    case 'SET_MUTE':
    case 'REORDER_SHOTS':
    case 'TRIM_SHOT':
    case 'SET_ROW_IMAGE':
    case 'SET_ROW_VIDEO':
    case 'SET_ROW_SCRIPT':
      return true;
    default:
      return false;
  }
}

/**
 * Re-key a `Record<number, string>` after a row is inserted or
 * removed. The key is the row's index, so inserting at index N
 * pushes every key ≥ N up by one; removing at index N pulls every
 * key > N down by one.
 *
 * Used by DELETE_SHOT (ripple mode) + RESTORE_ROW (insert mode) so
 * `rowImages` stays aligned with `doc.rows` indices.
 */
/**
 * Reindex `rowImages` after a row at `fromIndex` is moved to
 * `toIndex` (using `Array.splice`-style move semantics). Builds a
 * new map by walking the original keys and computing each key's
 * post-move index.
 */
function reorderRowImages(
  rowImages: Record<number, string>,
  fromIndex: number,
  toIndex: number,
): Record<number, string> {
  if (fromIndex === toIndex) return rowImages;
  const out: Record<number, string> = {};
  for (const [keyStr, url] of Object.entries(rowImages)) {
    const key = Number(keyStr);
    if (!Number.isFinite(key)) continue;
    let nextKey: number;
    if (key === fromIndex) {
      nextKey = toIndex;
    } else if (fromIndex < toIndex) {
      // Moving down: keys in (fromIndex, toIndex] shift up by one.
      nextKey = key > fromIndex && key <= toIndex ? key - 1 : key;
    } else {
      // Moving up: keys in [toIndex, fromIndex) shift down by one.
      nextKey = key >= toIndex && key < fromIndex ? key + 1 : key;
    }
    out[nextKey] = url;
  }
  return out;
}

function reindexRowImages(
  rowImages: Record<number, string>,
  atIndex: number,
  delta: 1 | -1,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [keyStr, url] of Object.entries(rowImages)) {
    const key = Number(keyStr);
    if (!Number.isFinite(key)) continue;
    if (delta === 1) {
      // Insert at atIndex: keys >= atIndex shift up by 1.
      out[key >= atIndex ? key + 1 : key] = url;
    } else {
      // Remove at atIndex: drop the deleted key; keys > atIndex
      // shift down by 1.
      if (key === atIndex) continue;
      out[key > atIndex ? key - 1 : key] = url;
    }
  }
  return out;
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
          voiceoverUrl: cmd.voiceoverUrl,
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
        edited_at: stampEditedAt(row.edited_at, 'duration'),
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
      const splitStamp = stampEditedAt(row.edited_at, 'structure');
      const firstHalf = { ...row, duration_override_ms: firstHalfMs, edited_at: splitStamp };
      // Structural clone with shifted-out duration. Same visual
      // content; the user diverges fields after the split if they
      // want. Both halves carry the same per-category stamp.
      const secondHalf = { ...row, duration_override_ms: secondHalfMs, edited_at: splitStamp };
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

    case 'SET_ROW_IMAGE': {
      const { shotIndex, url } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const prev = state.rowImages[shotIndex] ?? null;
      if (prev === url) return { next: state, inverse: null };
      const nextImages = { ...state.rowImages };
      if (url === null) {
        delete nextImages[shotIndex];
      } else {
        nextImages[shotIndex] = url;
      }
      const nextRow = {
        ...state.doc.rows[shotIndex],
        edited_at: stampEditedAt(state.doc.rows[shotIndex].edited_at, 'image'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'SET_ROW_IMAGE',
        shotIndex,
        url: prev,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SET_ROW_SCRIPT': {
      const { shotIndex, text } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const prevText = row.script_text ?? '';
      const normalised = text;
      if (prevText === normalised) {
        return { next: state, inverse: null };
      }
      const nextRow = {
        ...row,
        script_text: normalised,
        edited_at: stampEditedAt(row.edited_at, 'script_text'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'SET_ROW_SCRIPT',
        shotIndex,
        text: prevText,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SET_ROW_VIDEO': {
      const { shotIndex, url, durationSeconds } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const prevUrl = row.video_url_override ?? null;
      const prevDuration = row.video_duration_seconds_override ?? null;
      if (prevUrl === url && prevDuration === durationSeconds) {
        return { next: state, inverse: null };
      }
      const nextRow = {
        ...row,
        video_url_override: url ?? undefined,
        video_duration_seconds_override: durationSeconds ?? undefined,
        edited_at: stampEditedAt(row.edited_at, 'video'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'SET_ROW_VIDEO',
        shotIndex,
        url: prevUrl,
        durationSeconds: prevDuration,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'TRIM_SHOT': {
      const { shotIndex } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const prevStart = typeof row.trim_start_ms === 'number' ? row.trim_start_ms : null;
      const prevEnd = typeof row.trim_end_ms === 'number' ? row.trim_end_ms : null;

      // Resolve "leave unchanged" (undefined arg) vs. "clear" (null
      // arg) vs. "set to a number" (number arg).
      const targetStart =
        cmd.trimStartMs === undefined ? prevStart : cmd.trimStartMs;
      const targetEnd =
        cmd.trimEndMs === undefined ? prevEnd : cmd.trimEndMs;

      // Floor at 0 (no negative trim). Cap at EDITOR_MAX_SHOT_MS as a
      // sanity ceiling — a runaway pointer drag can't push trim into
      // the next century. Sub-frame integer rounding happens at the
      // renderer's startFrom conversion.
      const clamp = (n: number | null): number | null =>
        n === null ? null : Math.max(0, Math.min(EDITOR_MAX_SHOT_MS, Math.round(n)));
      const newStart = clamp(targetStart);
      const newEnd = clamp(targetEnd);

      if (newStart === prevStart && newEnd === prevEnd) {
        return { next: state, inverse: null };
      }

      const nextRow = {
        ...row,
        trim_start_ms: newStart ?? undefined,
        trim_end_ms: newEnd ?? undefined,
        edited_at: stampEditedAt(row.edited_at, 'trim'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;

      // Inverse restores the prior values. `null` here means "clear
      // the field" — distinguishable from `undefined` ("don't touch")
      // by the !==-vs-=== branches above.
      const inverse: EditorCommand = {
        type: 'TRIM_SHOT',
        shotIndex,
        trimStartMs: prevStart,
        trimEndMs: prevEnd,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'REORDER_SHOTS': {
      const { fromIndex, toIndex } = cmd;
      const len = state.doc.rows.length;
      if (
        fromIndex < 0 || fromIndex >= len ||
        toIndex < 0 || toIndex >= len ||
        fromIndex === toIndex
      ) {
        return { next: state, inverse: null };
      }
      const nextRows = state.doc.rows.slice();
      const [moved] = nextRows.splice(fromIndex, 1);
      nextRows.splice(toIndex, 0, moved);
      const nextImages = reorderRowImages(state.rowImages, fromIndex, toIndex);
      // Selection follows the moved row if it was selected; reindexes
      // for the other affected positions otherwise.
      let nextSelection = state.selection;
      if (nextSelection !== null) {
        if (nextSelection === fromIndex) {
          nextSelection = toIndex;
        } else if (fromIndex < toIndex) {
          if (nextSelection > fromIndex && nextSelection <= toIndex) {
            nextSelection -= 1;
          }
        } else {
          if (nextSelection >= toIndex && nextSelection < fromIndex) {
            nextSelection += 1;
          }
        }
      }
      const inverse: EditorCommand = {
        type: 'REORDER_SHOTS',
        fromIndex: toIndex,
        toIndex: fromIndex,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          selection: nextSelection,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SET_MUTE': {
      const { shotIndex, muted } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const prevMuted = row.muted === true;
      if (prevMuted === muted) {
        return { next: state, inverse: null };
      }
      const nextRow = {
        ...row,
        muted,
        edited_at: stampEditedAt(row.edited_at, 'mute'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'SET_MUTE',
        shotIndex,
        muted: prevMuted,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'DELETE_SHOT': {
      const { shotIndex, mode } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      // Refuse to delete the last remaining shot — an empty doc
      // breaks the renderer's totalFrames calculation downstream.
      // Phase 2 doesn't surface a "delete the whole project" path;
      // the user can go back to /production-doc for that.
      if (state.doc.rows.length === 1) {
        console.warn('[editor store] delete refused — can\'t empty the doc');
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const rowImageUrl = state.rowImages[shotIndex] ?? null;

      if (mode === 'ripple') {
        const nextRows = [
          ...state.doc.rows.slice(0, shotIndex),
          ...state.doc.rows.slice(shotIndex + 1),
        ];
        const nextImages = reindexRowImages(state.rowImages, shotIndex, -1);
        const inverse: EditorCommand = {
          type: 'RESTORE_ROW',
          atIndex: shotIndex,
          row,
          rowImageUrl,
          mode: 'insert',
        };
        // Selection: if the deleted row was selected, move to the
        // row that now occupies its slot (or the previous one when
        // we deleted the last row). Otherwise leave selection alone
        // but reindex if it was after the deleted row.
        let nextSelection = state.selection;
        if (nextSelection !== null) {
          if (nextSelection === shotIndex) {
            nextSelection = Math.min(shotIndex, nextRows.length - 1);
          } else if (nextSelection > shotIndex) {
            nextSelection -= 1;
          }
        }
        return {
          next: {
            ...state,
            doc: { ...state.doc, rows: nextRows },
            rowImages: nextImages,
            selection: nextSelection,
            isDirty: true,
          },
          inverse,
        };
      }

      // 'blank' mode: replace the row's visual content with a black
      // placeholder while keeping its slot + duration intact. VO
      // and music continue to play; the screen goes black for the
      // row's duration. Lets the user defer "fill this gap later"
      // edits without rewriting the voiceover timing.
      const blankedRow: ProductionDoc['rows'][number] = {
        ...row,
        // Drop the visual prompt + per-row image URL hint that the
        // generator wrote. The renderer's row-state lookup uses
        // rowImages[i]; clearing that slot (below) is the actual
        // mechanism. Visual fields here are cleared so a re-generation
        // round-trip can tell the row was deliberately blanked.
        ai_image_prompt: '',
        visual_description: '',
        visual_type: 'blank',
        on_screen_text: '',
        edited_at: stampEditedAt(row.edited_at, 'structure'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = blankedRow;
      // Drop the rowImages slot for this index so productionDocToVideoConfig
      // skips the image-state branch and the BRollScene falls back
      // to the row's `backgroundColor` (we don't set one here so
      // the renderer uses its default — black per BRollScene's
      // current pre-image fallback).
      const nextImages = { ...state.rowImages };
      delete nextImages[shotIndex];
      const inverse: EditorCommand = {
        type: 'RESTORE_ROW',
        atIndex: shotIndex,
        row,
        rowImageUrl,
        mode: 'replace',
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'RESTORE_ROW': {
      const { atIndex, row, rowImageUrl, mode } = cmd;
      if (atIndex < 0 || atIndex > state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      // Inverse depends on which mode this restore reverses.
      if (mode === 'insert') {
        // Reversing a ripple delete: insert the row back at atIndex
        // and bump every subsequent rowImages key up by one.
        // Its inverse is the original DELETE_SHOT (ripple).
        const nextRows = [
          ...state.doc.rows.slice(0, atIndex),
          row,
          ...state.doc.rows.slice(atIndex),
        ];
        let nextImages = reindexRowImages(state.rowImages, atIndex, 1);
        if (rowImageUrl !== null) {
          nextImages = { ...nextImages, [atIndex]: rowImageUrl };
        }
        const inverse: EditorCommand = {
          type: 'DELETE_SHOT',
          shotIndex: atIndex,
          mode: 'ripple',
        };
        return {
          next: {
            ...state,
            doc: { ...state.doc, rows: nextRows },
            rowImages: nextImages,
            isDirty: true,
            selection: atIndex,
          },
          inverse,
        };
      }
      // mode === 'replace' — reversing a blank delete: write the
      // row back into its slot + restore the image URL if any.
      if (atIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const nextRows = state.doc.rows.slice();
      nextRows[atIndex] = row;
      const nextImages = { ...state.rowImages };
      if (rowImageUrl !== null) {
        nextImages[atIndex] = rowImageUrl;
      } else {
        delete nextImages[atIndex];
      }
      const inverse: EditorCommand = {
        type: 'DELETE_SHOT',
        shotIndex: atIndex,
        mode: 'blank',
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          isDirty: true,
          selection: atIndex,
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
  voiceoverUrl?: string;
  version: number;
}): EditorState {
  return {
    doc: args.doc,
    rowImages: args.rowImages,
    voiceoverUrl: args.voiceoverUrl,
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
export function persistableFromState(state: EditorState): {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  voiceoverUrl?: string;
} {
  return {
    doc: state.doc,
    rowImages: state.rowImages,
    voiceoverUrl: state.voiceoverUrl,
  };
}
