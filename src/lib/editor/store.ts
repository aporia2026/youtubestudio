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
import type { MotionBeat, ProductionDoc, RowOverlayRenderState, RowVideoClipState } from '@/remotion/utils';
import { MAX_VARIANTS_PER_GROUP } from '@/remotion/utils';
import type { BrandKit, TextOverlay } from '@/remotion/types';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import type { ProjectPayloadFlags } from '@/lib/project/payload';
import type { ChannelVisualBrandKit } from '@/lib/channel-visual-brand-kit';
import type { CaptionsBundle } from './captions';
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
  /** Captions bundle generated from voiceoverUrl by the Phase 4
   *  transcription endpoint. The editor's caption overlay reads
   *  segments from here; reload-from-server refreshes after a
   *  regenerate. */
  captions: CaptionsBundle | undefined;
  /** Per-row overlay state — sparse, keyed by row index. Read from
   *  the saved payload on mount and round-tripped on every save so
   *  the renderer keeps compositing the same overlays the production-
   *  doc page set up. The renderer keys on this map (not on the
   *  row's `overlay_*` fields) for the live URL — without it loaded
   *  here, the editor's preview wouldn't show any overlays. See
   *  `_plans/2026-05-18-overlay-system-overhaul.md`. */
  rowOverlays: Record<number, RowOverlayRenderState>;
  /** Per-row B-roll clip state — sparse, keyed by row index. The
   *  editor doesn't generate clips (yet); this slot is pass-through
   *  so the next save preserves whatever production-doc wrote.
   *  Phase 2 of `_plans/2026-05-19-editor-production-doc-parity.md`. */
  rowVideoClips: Record<number, RowVideoClipState>;
  /** Background music URL. Pass-through state for now; the editor
   *  doesn't change it yet. */
  musicUrl: string | undefined;
  /** Per-doc visual brand kit override (pass-through; falls back to
   *  the channel kit and DEFAULT_BRAND_KIT in the renderer). Legacy
   *  shape; `visualKitOverride` below carries the new canonical
   *  `ChannelVisualBrandKit` for the full editable panel. */
  brandKitOverride: Partial<BrandKit> | undefined;
  /** Per-doc override of the channel's visual brand kit. Editable
   *  via the editor's BrandKitModal; the renderer resolves to the
   *  flat BrandKit via `resolveBrandKitForRender(channelKit, override)`. */
  visualKitOverride: ChannelVisualBrandKit | undefined;
  /** Workspace's pinned channel for this project (pass-through). */
  channelId: string | undefined;
  /** Word-level alignment from ElevenLabs (pass-through; the editor's
   *  preview uses it for scene-timing realignment). */
  voiceoverAlignment: ForcedAlignmentResponse | undefined;
  /** Project-level flags (animateScenes, suppressLowerThirds,
   *  overlaysDisabled, rowLockedAsStill). The editor's toolbar
   *  toggles flip these via SET_FLAGS; all other paths preserve. */
  flags: ProjectPayloadFlags;
  /** `projects.id` this user_history project is linked to. Pass-through
   *  state — the voiceover picker reads it to auto-match narrator
   *  audio. Batch A of parity-batches. */
  linkedProjectId: string | undefined;
  /** `schedule_items.id` the project was created from, when applicable.
   *  Strongest match signal for the voiceover picker. */
  linkedScheduleItemId: string | undefined;
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
  /** Note a server-side version bump that happened outside the
   *  full-payload PATCH path — e.g. a row-asset POST succeeded and the
   *  row's version is now newer than what the editor read on load.
   *  Updates `version` only; does NOT clear `isDirty` (other unsaved
   *  edits may still be pending) and does NOT touch the asset maps
   *  (the row-asset endpoint already wrote the new value, and the
   *  caller has dispatched the matching local update). Without this,
   *  the next debounced PATCH would fail the optimistic version check
   *  and surface a spurious conflict banner. */
  | { type: 'SYNC_SERVER_VERSION'; version: number }
  /** Set the voiceover alignment payload (forced-alignment words +
   *  characters). Fired after the editor auto-fetches alignment for a
   *  voiceover that loaded without one. Marks the state dirty so the
   *  alignment persists via the next debounced PATCH — without this,
   *  the editor would re-fetch the alignment on every mount and never
   *  cache it server-side. */
  | { type: 'SET_VOICEOVER_ALIGNMENT'; alignment: import('@/lib/elevenlabs').ForcedAlignmentResponse | undefined }
  | {
      type: 'RESET_FROM_SERVER';
      doc: ProductionDoc;
      rowImages: Record<number, string>;
      voiceoverUrl?: string;
      captions?: CaptionsBundle;
      rowOverlays?: Record<number, RowOverlayRenderState>;
      rowVideoClips?: Record<number, RowVideoClipState>;
      musicUrl?: string;
      brandKitOverride?: Partial<BrandKit>;
      channelId?: string;
      voiceoverAlignment?: ForcedAlignmentResponse;
      flags?: ProjectPayloadFlags;
      linkedProjectId?: string;
      linkedScheduleItemId?: string;
      visualKitOverride?: ChannelVisualBrandKit;
      version: number;
    }
  /** Load a localStorage-backed crash-recovery draft into state.
   *  Same payload shape as RESET_FROM_SERVER, but FLIPS isDirty TRUE
   *  so the next autosave debounce persists the recovered work to the
   *  server. Used by the editor's mount-time recovery prompt — see
   *  `src/lib/editor/draft-storage.ts`. */
  | {
      type: 'RESTORE_DRAFT';
      doc: ProductionDoc;
      rowImages: Record<number, string>;
      voiceoverUrl?: string;
      captions?: CaptionsBundle;
      rowOverlays?: Record<number, RowOverlayRenderState>;
      rowVideoClips?: Record<number, RowVideoClipState>;
      musicUrl?: string;
      brandKitOverride?: Partial<BrandKit>;
      channelId?: string;
      voiceoverAlignment?: ForcedAlignmentResponse;
      flags?: ProjectPayloadFlags;
      linkedProjectId?: string;
      linkedScheduleItemId?: string;
      visualKitOverride?: ChannelVisualBrandKit;
      /** The server version the draft was based on. Stays as the
       *  local version so the next save's optimistic-concurrency
       *  check still works. */
      version: number;
    }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | {
      type: 'RESIZE_SHOT';
      shotIndex: number;
      durationMs: number;
      /** Inverse-path only. When omitted, the forward path sets
       *  `row.pin_duration = true` (explicit user resize always
       *  pins — that's the whole point of the pin-duration plan).
       *  When provided, `.value` is written verbatim; `undefined`
       *  clears the field so the row's pre-edit pin state (which
       *  may have been absent) is restored exactly on undo.
       *  See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
      restorePinDuration?: { value: boolean | undefined };
    }
  | { type: 'SPLIT_SHOT'; shotIndex: number; splitAtMs: number }
  /** Atomic edit of both edges of a shot in a single undo step.
   *  Redistributes the start/end deltas across the immediate left and
   *  right neighbors (carve semantics: total project length unchanged
   *  unless the right edge is moved past the project end on the last
   *  shot, which falls back to shift). Used by the timeline's new
   *  left-edge drag handle AND the "Set timing…" precision popover.
   *
   *  Algorithm:
   *    - currentStart = sum(effectiveDuration(0..shotIndex-1))
   *    - currentEnd   = currentStart + effectiveDuration(shotIndex)
   *    - deltaStart   = startMs - currentStart
   *    - deltaEnd     = endMs   - currentEnd
   *    - Left neighbor (shotIndex > 0):
   *        newLeftDur = leftDur + deltaStart, clamped to
   *        [MIN_SHOT_MS, MAX_SHOT_MS]. If clamped, deltaStart shrinks
   *        accordingly so the scene's start lands on what was achievable.
   *    - Right neighbor (shotIndex < rows.length - 1):
   *        newRightDur = rightDur - deltaEnd, clamped similarly.
   *        If clamped, deltaEnd shrinks similarly.
   *    - This shot's new duration = (currentEnd + clampedDeltaEnd) -
   *      (currentStart + clampedDeltaStart), clamped to MIN/MAX.
   *    - Last-shot special case (no right neighbor): a positive
   *      deltaEnd just extends THIS shot's duration (shift fallback —
   *      project length grows).
   *
   *  Inverse: a SET_SHOT_TIMING that puts startMs / endMs back to
   *  their pre-edit values. One step undoes the whole composite edit
   *  regardless of how many neighbors moved.
   *
   *  See `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`. */
  /** Clear both `duration_override_ms` AND `pin_duration` on the
   *  named shot, releasing it back to alignment-driven timing.
   *  Surfaced as the "Reset timing to alignment" context-menu entry.
   *  Inverse restores both fields exactly (including absent → absent).
   *  See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
  | {
      type: 'RESET_SHOT_TIMING';
      shotIndex: number;
      /** Inverse-path only. Restores `duration_override_ms` to this
       *  value (undefined ⇒ clear). Forward callers omit. */
      restoreDurationMs?: { value: number | undefined };
      /** Inverse-path only. Mirrors the pin-restore pattern used by
       *  RESIZE_SHOT and SET_SHOT_TIMING. */
      restorePinDuration?: { value: boolean | undefined };
    }
  | {
      type: 'SET_SHOT_TIMING';
      shotIndex: number;
      startMs: number;
      endMs: number;
      /** Optional: override the reducer's cascade-current computation
       *  with caller-supplied values. Used by aligned-timebase callers
       *  (the Set timing popover, the leading-edge drag) so the delta
       *  math lands in their timebase instead of cascade — when
       *  alignment is active those two can differ by many seconds.
       *
       *  After dispatch, the shot AND left neighbor get pinned, so the
       *  rendered position equals the caller's typed values exactly
       *  (cascade-forward in realignVideoConfig still positions the
       *  pinned shot at the upstream realigned cursor, which is what
       *  the aligned-current math is designed to produce). See
       *  `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
      overrideCurrent?: {
        startMs: number;
        endMs: number;
        leftDurationMs?: number;
      };
      /** Inverse-path only. Per-affected-row pin-state restore (this
       *  shot AND the carved left neighbor when applicable). Forward
       *  callers omit; reducer defaults to pin=true on touched rows.
       *  See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
      restorePinDuration?: {
        thisShot: { value: boolean | undefined };
        leftNeighbor?: { value: boolean | undefined };
      };
    }
  /** Toolbar flag toggle — animateScenes / suppressLowerThirds /
   *  overlaysDisabled (the per-row `rowLockedAsStill` map mutates
   *  via the same path but is patched in full when it changes).
   *  Inverse stores the prior flag state so undo restores the
   *  exact previous configuration. */
  | { type: 'SET_FLAGS'; flags: Partial<ProjectPayloadFlags> }
  /** Edit one caption segment's text. Used by the captions-lane
   *  inline editor (double-click a pill). Inverse stores the prior
   *  text so undo restores it. No-op when the new text matches the
   *  prior text. */
  | { type: 'UPDATE_CAPTION_SEGMENT'; segmentIndex: number; text: string }
  /** Re-align a caption segment's [start, end) timing in seconds.
   *  Used by the captions context menu's "Re-align from playhead"
   *  action, which shifts the segment's start to the current
   *  playhead and keeps its duration. Self-inverse — the inverse
   *  carries the prior `start` / `end` values. No-op when both
   *  values match the current segment. */
  | {
      type: 'SET_CAPTION_SEGMENT_TIMING';
      segmentIndex: number;
      startSeconds: number;
      endSeconds: number;
    }
  /** Swap the project's voiceover URL. Used by the editor's
   *  voiceover picker (auto-match + manual select). Inverse stores
   *  the prior URL so undo restores it. Pass `null` / empty string
   *  to clear. No-op when the new URL matches the prior URL.
   *  `restoreAlignment` is set only by the inverse path so Cmd+Z can
   *  put the previously-cached word-level timings back in place
   *  alongside the URL; forward callers leave it undefined. */
  | { type: 'SET_VOICEOVER_URL'; url: string | null; restoreAlignment?: ForcedAlignmentResponse }
  /** Doc-level patch — used for fields that live on `state.doc`
   *  itself (thumbnail, overlays_disabled, scene_fade_enabled,
   *  min_scene_ms, etc.) rather than per-row. Inverse stores the
   *  prior shallow-merge of the patched keys so undo restores them
   *  one at a time. Batch B of parity-batches. */
  | { type: 'PATCH_DOC'; patch: Partial<ProductionDoc> }
  /** Swap the project's `visualKitOverride`. Editable from the
   *  editor's BrandKitModal (Batch — 2026-05-20 brand-kit panel
   *  port). Inverse stores the prior value so undo restores it.
   *  Pass `undefined` to clear. */
  | { type: 'SET_VISUAL_KIT_OVERRIDE'; override: ChannelVisualBrandKit | undefined }
  /** Set / clear the per-row B-roll clip render state. Used by the
   *  editor's inspector when the user kicks off a clip generation,
   *  and by the EditorClient's poller as the clip progresses
   *  generating → ready. `transient` skips the undo stack so the
   *  intermediate 'generating' state doesn't make Cmd+Z bounce
   *  through every poll tick. */
  | {
      type: 'SET_ROW_VIDEO_CLIP';
      rowIndex: number;
      clip: RowVideoClipState | null;
      transient?: boolean;
    }
  // MERGE_ADJACENT_SHOTS exists only as the inverse of SPLIT_SHOT.
  // Users never dispatch it directly; the reducer emits it when
  // building an undo entry.
  | {
      type: 'MERGE_ADJACENT_SHOTS';
      shotIndex: number;
      restoredDurationOverrideMs: number | null;
      /** Pre-split pin state of the original row, restored on the
       *  merged row. Inverse of SPLIT_SHOT captures this so undo
       *  restores the exact pre-split row shape. Absent ⇒ legacy
       *  inverse from before the pin-duration feature; leave
       *  pin_duration as-is. See
       *  `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
      restorePinDuration?: { value: boolean | undefined };
      /** Pre-split motion_beats[] array, restored verbatim on the
       *  merged row. SPLIT_SHOT slices the array into the two halves
       *  (dropping spanners); MERGE has to put the original back so
       *  redo-after-undo reproduces the same slice from the same
       *  source. `value: undefined` ⇒ pre-split row had no motion
       *  beats; the field is deleted on the merged row. Absent on the
       *  command ⇒ legacy inverse from before the motion-beat slice
       *  feature; leave motion_beats as-is. See
       *  `_plans/2026-06-02-shot-split-ui.md`. */
      restoreMotionBeats?: { value: MotionBeat[] | undefined };
    }
  | { type: 'DELETE_SHOT'; shotIndex: number; mode: 'ripple' | 'blank' }
  /** Insert a clone of the row at `shotIndex` into position
   *  `shotIndex + 1`. The clone inherits everything (script,
   *  visuals, duration override, trim, overlay) so the user can
   *  start from a known-good baseline. Selection moves to the new
   *  slot. Inverse is a ripple DELETE_SHOT on the new slot. Phase 3
   *  follow-up — surfaced by the right-click context menu. */
  | { type: 'DUPLICATE_SHOT'; shotIndex: number }
  /** Insert a fresh, blank-content row at `atIndex` (valid range
   *  `[0, rows.length]`; `rows.length` appends). The new row has
   *  empty script / visual fields, no image, no overlay, no broll —
   *  the user fills it in afterward.
   *
   *  Two modes govern how the new row's duration interacts with the
   *  surrounding cascade:
   *
   *    – `'carve'`: the new row steals `durationMs` from one of the
   *      neighbors so the total project length is unchanged. Used to
   *      fix audio-vs-visual mismatches at a seam — downstream
   *      visuals stay aligned with the voiceover. `carveFrom` picks
   *      which side gives up the time; falls back to the other side
   *      if the preferred side can't give enough slack without
   *      dropping below `EDITOR_MIN_SHOT_MS`. No-op (with a console
   *      warn) when neither neighbor has ≥ `2 * EDITOR_MIN_SHOT_MS`
   *      effective duration.
   *
   *    – `'shift'`: the new row adds `durationMs` to the total
   *      project length; every downstream visual shifts later in
   *      absolute time, the voiceover plays straight through. Used
   *      to add a beat / breathing room.
   *
   *  Selection moves to the new row. Inverse is REMOVE_INSERTED_SHOT
   *  which also restores the carved neighbor's prior override (if any).
   *  See `_plans/2026-05-23-editor-insert-blank-scene-between.md`. */
  | {
      type: 'INSERT_BLANK_SHOT';
      atIndex: number;
      mode: 'carve' | 'shift';
      durationMs: number;
      /** Carve mode only. `'auto'` picks the larger neighbor;
       *  `'left'`/`'right'` force a specific side and fall back to
       *  the other if the preferred can't give enough slack. Ignored
       *  in shift mode. */
      carveFrom?: 'left' | 'right' | 'auto';
    }
  /** Inverse of INSERT_BLANK_SHOT. Removes the row at `atIndex`,
   *  reindexes `rowImages` / `rowOverlays` / `rowVideoClips` down by
   *  one, and (when `restoreNeighbor` is present) puts the carved
   *  neighbor's `duration_override_ms` back to its pre-carve value.
   *  `value: null` means the neighbor had no override before the carve
   *  — clear the field entirely. Built as an inverse only; users never
   *  dispatch it directly. */
  | {
      type: 'REMOVE_INSERTED_SHOT';
      atIndex: number;
      restoreNeighbor?: {
        rowIndex: number;
        value: number | null;
        /** Pre-carve pin state of the neighbor. Forward-path
         *  INSERT_BLANK_SHOT pins the carved neighbor (the user's
         *  insert intent extends to the row whose duration just got
         *  modified). Undo restores the prior pin state exactly.
         *  See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
        restorePin?: { value: boolean | undefined };
      };
    }
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
  // Set the cross-fade transition INTO this shot (the gap between
  // shot-1 and shot is what the user sees fade). `null` clears any
  // explicit override and falls back to the doc-level default.
  | { type: 'SET_TRANSITION_IN'; shotIndex: number; transition: 'cross-fade' | null }
  // Doc-level text overlays. Append-and-edit feature; each overlay
  // is identified by `id` (uuid client-generated). Inverses are
  // symmetric: ADD ↔ DELETE, UPDATE inverts via the prior value.
  | { type: 'ADD_TEXT_OVERLAY'; overlay: TextOverlay; insertAtIndex?: number }
  | { type: 'UPDATE_TEXT_OVERLAY'; id: string; patch: Partial<Omit<TextOverlay, 'id'>> }
  | { type: 'DELETE_TEXT_OVERLAY'; id: string }
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
      /** Per-row field restorations applied AFTER the deleted row is
       *  re-inserted. Used by the ripple-delete inverse to undo the
       *  CapCut-shift bookkeeping the forward path stamps on neighbors
       *  (left-neighbor + last-row duration locks and the leftward
       *  timecode shift on rows after the splice point).
       *
       *  Indices are POST-RESTORE — i.e., they reference the array
       *  AFTER the deleted row has been re-inserted at `atIndex`.
       *  `prevDurationOverrideMs: undefined` ⇒ clear the field
       *  (the row had no override pre-delete). `prevDurationOverrideMs:
       *  number` ⇒ restore that exact value. Omitting the field ⇒
       *  don't touch `duration_override_ms`. Same shape for
       *  `prevTimecode`. */
      restoreRowFields?: ReadonlyArray<{
        rowIndex: number;
        prevTimecode?: string;
        prevDurationOverrideMs?: number;
        /** When `prevDurationOverrideMs` is omitted but this flag is
         *  true, the inverse CLEARS the override field on that row
         *  (forward stamped a new one on a row that previously had
         *  none). */
        clearDurationOverride?: boolean;
      }>;
    }
  /** General-purpose partial-merge of any row fields. Used by the
   *  overlay-port commit B for placement / size / stretched-height /
   *  edit-history mutations because those fields don't each warrant
   *  a first-class command. Inverse captures the OLD values of the
   *  patched keys so undo restores them exactly. Use sparingly — for
   *  fields the editor already has dedicated commands for, prefer
   *  those (they carry richer semantics / better inverses). */
  | {
      type: 'PATCH_ROW';
      rowIndex: number;
      patch: Partial<ProductionDoc['rows'][number]>;
      /** When true, apply the patch to local state but do NOT mark
       *  state dirty and do NOT push an undo entry. Used for live-
       *  preview updates during a drag — 60 pointermove ticks per
       *  second would otherwise pump 60 undo entries + 60 dirty-flag
       *  flips into the store every second, lagging the UI and
       *  starting a save storm. The non-transient commit fires once
       *  on pointerup with the final value. */
      transient?: boolean;
    }
  /** Set or clear the per-row overlay render state (the URL + status
   *  the renderer reads to composite an overlay). Passing `null`
   *  clears the slot entirely. Inverse restores the previous state.
   *
   *  `transient: true` marks the change as ephemeral UI state (e.g.,
   *  `{ status: 'loading' }` during a fetch). The reducer applies the
   *  change + marks dirty so save still picks it up, but NO inverse
   *  is pushed to the undo stack — Cmd+Z then skips over transient
   *  status transitions and reverses only the user's actual intent
   *  (the final `{ status: 'done', url }`). */
  | {
      type: 'SET_ROW_OVERLAY';
      rowIndex: number;
      overlay: RowOverlayRenderState | null;
      transient?: boolean;
    }
  /** Composite command: accept an AI edit. Atomically updates the
   *  row's edit-history stack AND the live overlay URL. The inverse
   *  is a single REVERT_OVERLAY_EDIT_TO that restores both fields,
   *  so Cmd+Z reverses the entire edit in one click — instead of
   *  the two-or-three-Cmd+Z dance the previous PATCH_ROW +
   *  SET_ROW_OVERLAY pair required. Production-doc continues to use
   *  raw setState; only the editor routes through this. */
  | {
      type: 'ACCEPT_OVERLAY_EDIT';
      rowIndex: number;
      newUrl: string;
      replacedUrl: string;
      mode: 'smart' | 'brush';
    }
  /** Composite inverse for ACCEPT_OVERLAY_EDIT. Snapshot of a row's
   *  overlay URL + edit-history at a known prior state. Forward
   *  action restores that snapshot. The ↶ Undo button dispatches
   *  this directly with the second-to-last history entry; Cmd+Z
   *  dispatches it via the undo stack as the inverse of a prior
   *  ACCEPT_OVERLAY_EDIT. */
  | {
      type: 'REVERT_OVERLAY_EDIT_TO';
      rowIndex: number;
      restoredUrl: string;
      restoredHistory: string[];
    }
  /** Promote the row at `baseIndex` into a variant group (or extend an
   *  existing one) and insert a new variant row right after the last
   *  member of that group. If the base row was standalone, this is when
   *  it gets stamped with `group_id` + `variant_index = 0`. The new
   *  variant clones the base's scene-context fields (visual_type,
   *  visual_description, stock_search_terms) and leaves
   *  ai_image_prompt / script_text / on_screen_text empty — the edit
   *  dispatcher composes the actual generation prompt from the base
   *  prompt + the variant's `variant_edit_prompt` (filled in by the
   *  user after this command lands). Refuses when the group is at
   *  `MAX_VARIANTS_PER_GROUP`. Mirrors the production-doc grid's
   *  `addVariantRow` semantics.
   *
   *  Inverse is `REVERT_ADD_VARIANT_ROW`, which removes the inserted
   *  variant AND (when the forward action promoted the base in the
   *  same step) restores the base row's prior group_id / variant_index
   *  exactly — so Cmd+Z brings the doc back to a true standalone state
   *  rather than leaving a base with an empty group. */
  | { type: 'ADD_VARIANT_ROW'; baseIndex: number }
  /** Inverse of ADD_VARIANT_ROW. Removes the variant row at
   *  `variantIndex` and, when `restoreBase` is present, un-stamps the
   *  base row's group_id / variant_index (which the forward command had
   *  added on first promotion). `variantIndex` is the index AFTER the
   *  original splice — i.e. where the forward inserted the variant. */
  | {
      type: 'REVERT_ADD_VARIANT_ROW';
      variantIndex: number;
      restoreBase?: {
        rowIndex: number;
        priorGroupId: string | undefined;
        priorVariantIndex: number | undefined;
        priorGroupChainDefault: 'parallel' | 'chained' | undefined;
      };
    }
  /** Delete a single variant row (variant_index > 0). Re-numbers the
   *  remaining variants in the same group so their indices are 1..N-1
   *  with no gaps. Does NOT unpromote the base — mirroring production-
   *  doc behavior; an "orphaned" base with group_id but zero variants
   *  is a deliberate accepted state. Use REVERT_ADD_VARIANT_ROW with
   *  restoreBase if you specifically need to undo the promotion. */
  | { type: 'DELETE_VARIANT_ROW'; rowIndex: number }
  /** Inverse of DELETE_VARIANT_ROW. Re-inserts the deleted variant
   *  back into the row list at `atIndex`, restores its rowImages slot,
   *  and re-numbers the group's variants so the inserted row reclaims
   *  its prior `variant_index`. */
  | {
      type: 'RESTORE_VARIANT_ROW';
      atIndex: number;
      row: ProductionDoc['rows'][number];
      rowImageUrl: string | null;
      /** Same shape as RESTORE_ROW.restoreRowFields — post-restore
       *  indices, replays timecode + duration_override_ms restorations
       *  that the forward DELETE_VARIANT_ROW stamped on neighbors. */
      restoreRowFields?: ReadonlyArray<{
        rowIndex: number;
        prevTimecode?: string;
        prevDurationOverrideMs?: number;
        clearDurationOverride?: boolean;
      }>;
    }
  /** Swap a variant row with its adjacent sibling in the same group.
   *  Refuses to cross a group boundary or move past the base. Updates
   *  both the row positions in `doc.rows` AND the `variant_index`
   *  values on the two swapped rows so the indices stay consistent.
   *  Self-inverse: the inverse is the same command with `direction`
   *  flipped. Re-keys rowImages / rowOverlays / rowVideoClips for the
   *  two swapped row positions. */
  | { type: 'MOVE_VARIANT_ROW'; rowIndex: number; direction: 'up' | 'down' }
  /** Set a row's `visual_type` field. When `promoteFields` is true AND
   *  the new type is 'Title Card', also runs the production-doc
   *  "Make this a title card" side-effects: clears `ai_image_prompt`,
   *  `visual_description`, `stock_search_terms`, lifts the row's
   *  `script_text` into `on_screen_text`, and backs the prior prompt
   *  into notes. The inverse is a `PATCH_ROW` that restores every
   *  field touched — so Cmd+Z reverses the full promotion in one step,
   *  not just the visual_type flip. */
  | {
      type: 'SET_ROW_VISUAL_TYPE';
      rowIndex: number;
      visualType: string;
      promoteFields?: boolean;
    }
  /** Split a leading `## heading` out of a row's `script_text` into a
   *  fresh Title Card row inserted ABOVE the source row. The source
   *  row's script_text loses the matched heading; the new row keeps
   *  the heading as `on_screen_text` and sets `visual_type =
   *  'Title Card'`. Reindexes all three per-row asset maps so the
   *  source row's image / overlay / clip ride along with it to its new
   *  index. The inverse is a composite REVERT_SPLIT_AS_TITLE_CARD that
   *  removes the title card AND restores the source's original
   *  script_text in one undo step. */
  | { type: 'SPLIT_AS_TITLE_CARD'; rowIndex: number; heading: string }
  /** Inverse of SPLIT_AS_TITLE_CARD. Removes the title card row at
   *  `atIndex` and restores the source row's pre-split `script_text`. */
  | {
      type: 'REVERT_SPLIT_AS_TITLE_CARD';
      atIndex: number;
      sourceRowIndex: number;
      restoreScriptText: string;
    }
  /** Propagate a Title Card row's text down through every row below it
   *  (up to but not including the next Title Card or doc end) as the
   *  `section_title` field. Production-doc surfaces this as the
   *  "Apply as section title →" button on a Title Card row. Source text
   *  is `on_screen_text` (preferred) or `script_text`, trimmed. Refuses
   *  when the source row isn't a Title Card or when there's no text to
   *  propagate. Inverse restores each affected row's prior
   *  section_title verbatim. */
  | { type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE'; rowIndex: number }
  /** Inverse of APPLY_TITLE_CARD_AS_SECTION_TITLE. Restores each
   *  affected row's prior `section_title` (undefined ⇒ delete the
   *  field). */
  | {
      type: 'REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE';
      restore: Array<{ rowIndex: number; priorSectionTitle: string | undefined }>;
    };

/** Discriminator: editing commands push to the undo stack; non-
 *  editing commands (selection, playhead, save lifecycle, undo/redo
 *  themselves) do not. */
function isEditingCommand(cmd: EditorCommand): boolean {
  switch (cmd.type) {
    case 'RESIZE_SHOT':
    case 'SPLIT_SHOT':
    case 'SET_SHOT_TIMING':
    case 'RESET_SHOT_TIMING':
    case 'MERGE_ADJACENT_SHOTS':
    case 'DELETE_SHOT':
    case 'RESTORE_ROW':
    case 'SET_MUTE':
    case 'REORDER_SHOTS':
    case 'TRIM_SHOT':
    case 'SET_ROW_IMAGE':
    case 'SET_ROW_VIDEO':
    case 'SET_ROW_SCRIPT':
    case 'SET_TRANSITION_IN':
    case 'ADD_TEXT_OVERLAY':
    case 'UPDATE_TEXT_OVERLAY':
    case 'DELETE_TEXT_OVERLAY':
    case 'PATCH_ROW':
    case 'SET_ROW_OVERLAY':
    case 'ACCEPT_OVERLAY_EDIT':
    case 'REVERT_OVERLAY_EDIT_TO':
    case 'SET_FLAGS':
    case 'SET_ROW_VIDEO_CLIP':
    case 'UPDATE_CAPTION_SEGMENT':
    case 'SET_CAPTION_SEGMENT_TIMING':
    case 'SET_VOICEOVER_URL':
    case 'PATCH_DOC':
    case 'SET_VISUAL_KIT_OVERRIDE':
    case 'DUPLICATE_SHOT':
    case 'INSERT_BLANK_SHOT':
    case 'REMOVE_INSERTED_SHOT':
    case 'ADD_VARIANT_ROW':
    case 'REVERT_ADD_VARIANT_ROW':
    case 'DELETE_VARIANT_ROW':
    case 'RESTORE_VARIANT_ROW':
    case 'MOVE_VARIANT_ROW':
    case 'SET_ROW_VISUAL_TYPE':
    case 'SPLIT_AS_TITLE_CARD':
    case 'REVERT_SPLIT_AS_TITLE_CARD':
    case 'APPLY_TITLE_CARD_AS_SECTION_TITLE':
    case 'REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE':
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
  return reindexRecord(rowImages, atIndex, delta);
}

/** Generic version of reindexRowImages — shifts numeric-keyed map
 *  entries when a row is inserted (`delta === 1`) or removed
 *  (`delta === -1`) at `atIndex`. Used by DUPLICATE_SHOT to keep
 *  rowOverlays + rowVideoClips attached to the right rows after
 *  the splice. */
function reindexRecord<V>(
  record: Record<number, V>,
  atIndex: number,
  delta: 1 | -1,
): Record<number, V> {
  const out: Record<number, V> = {};
  for (const [keyStr, value] of Object.entries(record)) {
    const key = Number(keyStr);
    if (!Number.isFinite(key)) continue;
    if (delta === 1) {
      // Insert at atIndex: keys >= atIndex shift up by 1.
      out[key >= atIndex ? key + 1 : key] = value;
    } else {
      // Remove at atIndex: drop the deleted key; keys > atIndex
      // shift down by 1.
      if (key === atIndex) continue;
      out[key > atIndex ? key - 1 : key] = value;
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

    case 'SYNC_SERVER_VERSION':
      // Only move version forward. A stale dispatch (response arriving
      // after a later write already bumped local state) would otherwise
      // reset version backwards and re-introduce the conflict it's
      // meant to prevent.
      return cmd.version > state.version
        ? { next: { ...state, version: cmd.version }, inverse: null }
        : { next: state, inverse: null };

    case 'SET_VOICEOVER_ALIGNMENT':
      // No-op when the alignment payload is structurally equal — avoids
      // a redundant dirty flag + debounced PATCH for a no-change update
      // (e.g., the auto-fetch effect re-runs and gets the same result).
      if (
        JSON.stringify(state.voiceoverAlignment ?? null) ===
        JSON.stringify(cmd.alignment ?? null)
      ) {
        return { next: state, inverse: null };
      }
      return {
        next: { ...state, voiceoverAlignment: cmd.alignment, isDirty: true },
        inverse: null,
      };

    case 'RESTORE_DRAFT':
    case 'RESET_FROM_SERVER':
      return {
        next: {
          ...state,
          doc: cmd.doc,
          rowImages: cmd.rowImages,
          voiceoverUrl: cmd.voiceoverUrl,
          captions: cmd.captions,
          rowOverlays: cmd.rowOverlays ?? {},
          rowVideoClips: cmd.rowVideoClips ?? {},
          musicUrl: cmd.musicUrl,
          brandKitOverride: cmd.brandKitOverride,
          channelId: cmd.channelId,
          voiceoverAlignment: cmd.voiceoverAlignment,
          flags: cmd.flags ?? state.flags,
          linkedProjectId: cmd.linkedProjectId,
          linkedScheduleItemId: cmd.linkedScheduleItemId,
          visualKitOverride: cmd.visualKitOverride,
          version: cmd.version,
          // RESTORE_DRAFT flips dirty TRUE so the next autosave
          // commits the recovered work to the server. RESET_FROM_SERVER
          // is a clean reload from the canonical store — dirty stays
          // false until the user makes a new edit.
          isDirty: cmd.type === 'RESTORE_DRAFT',
          undoStack: [],
          redoStack: [],
          selection: null,
          // Snap the playhead to the start. The pre-reset position
          // may be past the end of the new (possibly shorter) doc;
          // clamping there would be confusing. Snap to 0 — the user
          // can scrub back where they were.
          playheadMs: 0,
          // Clear the local "saved 4s ago" clock. The server-fetched
          // state is fresh; the prior lastSavedAt referred to a
          // different version of the doc.
          lastSavedAt: null,
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
      // No-op detection: same duration AND same pin intent. The pin
      // check matters because the forward path sets pin=true, so a
      // user resize on a previously-unpinned row IS a state change
      // even when the requested duration matches the current one.
      const wantPinTrue = cmd.restorePinDuration === undefined;
      const targetPin = wantPinTrue ? true : cmd.restorePinDuration!.value;
      if (prevDurationMs === clampedMs && row.pin_duration === targetPin) {
        return { next: state, inverse: null };
      }
      // Inverse captures both the prior duration AND the prior pin
      // state so undo restores the exact pre-edit row shape (including
      // a missing pin_duration field if it was absent before).
      const inverse: EditorCommand = {
        type: 'RESIZE_SHOT',
        shotIndex,
        durationMs:
          typeof prevDurationMs === 'number'
            ? prevDurationMs
            : naturalRowDurationMs(state.doc, shotIndex),
        restorePinDuration: capturePinState(row),
      };
      const nextRow = {
        ...row,
        duration_override_ms: clampedMs,
        edited_at: stampEditedAt(row.edited_at, 'duration'),
      };
      applyPinDirective(nextRow, cmd.restorePinDuration);
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

    case 'SET_SHOT_TIMING': {
      const { shotIndex } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const rows = state.doc.rows;

      // Build the current cascade up to this shot. effDur() resolves
      // per-row to either the explicit override or the timecode-natural
      // value (mirrors what `productionDocToVideoConfig` does at render).
      const effDur = (i: number) =>
        typeof rows[i].duration_override_ms === 'number'
          ? (rows[i].duration_override_ms as number)
          : naturalRowDurationMs(state.doc, i);
      // When the caller provides `overrideCurrent`, use those values
      // as the delta base instead of cascade-derived values. This is
      // what makes the popover work in aligned timebase: the caller
      // passes videoConfig.shots[i].startMs / .durationMs (post-
      // alignment), the deltas land in aligned space, and after pin
      // the rendered position equals the caller's typed values
      // (provable: see the plan's "Edge case analysis" table for the
      // pin-duration cascade-forward math). Without overrideCurrent
      // we fall back to the historical cascade-only path used by the
      // tests and the trailing-edge drag.
      // 2026-05-23 pin-duration architecture follow-up.
      let currentStart: number;
      let currentDur: number;
      let leftCurForCarve: number | null = null;
      if (cmd.overrideCurrent) {
        currentStart = cmd.overrideCurrent.startMs;
        currentDur = cmd.overrideCurrent.endMs - cmd.overrideCurrent.startMs;
        if (cmd.overrideCurrent.leftDurationMs !== undefined) {
          leftCurForCarve = cmd.overrideCurrent.leftDurationMs;
        }
      } else {
        currentStart = 0;
        for (let i = 0; i < shotIndex; i += 1) currentStart += effDur(i);
        currentDur = effDur(shotIndex);
      }
      const currentEnd = currentStart + currentDur;

      const requestedStart = Math.round(cmd.startMs);
      const requestedEnd = Math.round(cmd.endMs);
      const requestedDeltaStart = requestedStart - currentStart;
      const requestedDeltaEnd = requestedEnd - currentEnd;

      // First shot's start is anchored at 0 — silently absorb any
      // deltaStart attempt rather than dispatching a confusing error.
      const hasLeft = shotIndex > 0;
      const clamp = (n: number) =>
        Math.max(EDITOR_MIN_SHOT_MS, Math.min(EDITOR_MAX_SHOT_MS, Math.round(n)));

      // Left side: CARVE from the immediate left neighbor. There's no
      // alternative for the leading edge — shifting "everything before
      // earlier" would compress past shot 0 which is anchored at 0.
      // Positive deltaStart ⇒ scene starts LATER ⇒ left neighbor
      // grows. Negative ⇒ scene starts earlier ⇒ left neighbor
      // shrinks. Clamp to MIN/MAX; the actual deltaStart shrinks to
      // whatever the neighbor can give.
      let actualDeltaStart = 0;
      let leftMutation: { rowIndex: number; priorOverride: number | null; nextOverride: number } | null = null;
      if (hasLeft && requestedDeltaStart !== 0) {
        const leftIdx = shotIndex - 1;
        // Use the caller-supplied left dur when overrideCurrent is
        // active (aligned-timebase math) — otherwise fall back to
        // cascade. Critical for the popover: aligned_left_dur +
        // aligned_delta_start gives the cascade dur we need to write
        // so the rendered cursor lands on the user's typed start.
        const leftCur = leftCurForCarve ?? effDur(leftIdx);
        const leftRequested = leftCur + requestedDeltaStart;
        const leftClamped = clamp(leftRequested);
        actualDeltaStart = leftClamped - leftCur;
        if (actualDeltaStart !== 0) {
          const leftPrior =
            typeof rows[leftIdx].duration_override_ms === 'number'
              ? (rows[leftIdx].duration_override_ms as number)
              : null;
          leftMutation = {
            rowIndex: leftIdx,
            priorOverride: leftPrior,
            nextOverride: leftClamped,
          };
        }
      }

      // Right side: SHIFT (NOT carve). Originally this command carved
      // from the right neighbor so total length stayed unchanged — but
      // that fails the second the user wants to extend a shot whose
      // right neighbor is already at the 2 s floor (a freshly-inserted
      // blank, for instance). The user reported this as "Set timing
      // does nothing" and clarified that they expect "all other scenes
      // adjusted" — i.e. downstream shifts later, matching what the
      // trailing-edge drag already does and what every NLE does.
      //
      // 2026-05-23 semantics change: the requested deltaEnd flows
      // entirely into THIS shot's duration. The right neighbor never
      // mutates here; its start time shifts later automatically via
      // the cascade. Total project length grows by (deltaEnd - actualDeltaStart).
      const actualDeltaEnd = requestedDeltaEnd;

      const newDur = clamp(currentDur - actualDeltaStart + actualDeltaEnd);
      // No-op detection: nothing changed after all the clamping.
      // With shift semantics on the right, actualDeltaEnd === 0 only
      // when the user didn't move the end at all.
      if (
        actualDeltaStart === 0 &&
        actualDeltaEnd === 0 &&
        newDur === currentDur &&
        leftMutation === null
      ) {
        return { next: state, inverse: null };
      }

      // Build the mutation. Order of operations doesn't matter — we
      // mutate by index into a fresh slice, no cascade dependency.
      // applyPinDirective handles the forward/inverse split: forward
      // (cmd.restorePinDuration === undefined) sets pin_duration =
      // true; inverse restores the prior state captured at edit time.
      const nextRows = rows.slice();
      const priorLeftPin = leftMutation
        ? capturePinState(rows[leftMutation.rowIndex])
        : undefined;
      if (leftMutation) {
        const r = nextRows[leftMutation.rowIndex];
        const updated = {
          ...r,
          duration_override_ms: leftMutation.nextOverride,
          edited_at: stampEditedAt(r.edited_at, 'duration'),
        };
        applyPinDirective(updated, cmd.restorePinDuration?.leftNeighbor);
        nextRows[leftMutation.rowIndex] = updated;
      }
      const thisRow = nextRows[shotIndex];
      const priorThisPin = capturePinState(rows[shotIndex]);
      const updatedThis = {
        ...thisRow,
        duration_override_ms: newDur,
        edited_at: stampEditedAt(thisRow.edited_at, 'duration'),
      };
      applyPinDirective(updatedThis, cmd.restorePinDuration?.thisShot);
      nextRows[shotIndex] = updatedThis;

      // Observability for clamp surfacing — the EditorClient subscribes
      // via console for now, sonner toast for the popover path.
      if (actualDeltaStart !== requestedDeltaStart) {
        console.info('[editor set-shot-timing] clamp applied', {
          shotIndex,
          requestedStart,
          requestedEnd,
          actualStart: currentStart + actualDeltaStart,
          actualEnd: currentEnd + actualDeltaEnd,
        });
      }

      // Inverse restores the prior timing AND prior pin state for
      // both touched rows. One command, one undo step.
      const inverse: EditorCommand = {
        type: 'SET_SHOT_TIMING',
        shotIndex,
        startMs: currentStart,
        endMs: currentEnd,
        restorePinDuration: {
          thisShot: priorThisPin,
          leftNeighbor: priorLeftPin,
        },
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

    case 'RESET_SHOT_TIMING': {
      const { shotIndex } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      // No-op when both fields are already absent (and the inverse
      // hints — if provided — would write nothing). Forward path:
      // there's nothing to reset.
      const isForward = cmd.restoreDurationMs === undefined && cmd.restorePinDuration === undefined;
      if (isForward && row.duration_override_ms === undefined && row.pin_duration === undefined) {
        return { next: state, inverse: null };
      }
      const priorDuration = row.duration_override_ms;
      const priorPin = capturePinState(row);
      const nextRow: typeof row = { ...row };
      // Apply duration: forward clears; inverse restores explicit value.
      if (cmd.restoreDurationMs === undefined) {
        // Forward path or "inverse with no duration to restore": clear.
        delete (nextRow as { duration_override_ms?: number }).duration_override_ms;
      } else if (cmd.restoreDurationMs.value === undefined) {
        delete (nextRow as { duration_override_ms?: number }).duration_override_ms;
      } else {
        nextRow.duration_override_ms = cmd.restoreDurationMs.value;
      }
      // Apply pin: forward clears; inverse restores prior value.
      if (cmd.restorePinDuration === undefined) {
        // Forward path or inverse with no pin to restore.
        delete (nextRow as { pin_duration?: boolean }).pin_duration;
      } else {
        applyPinDirective(nextRow, cmd.restorePinDuration);
      }
      // Stamp edit so the auto-pipeline regen path knows this row
      // was user-touched (mirrors RESIZE_SHOT's edited_at stamp).
      nextRow.edited_at = stampEditedAt(row.edited_at, 'duration');
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'RESET_SHOT_TIMING',
        shotIndex,
        restoreDurationMs: { value: priorDuration },
        restorePinDuration: priorPin,
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
      const priorPin = capturePinState(row);
      // Pre-split snapshot captured for the inverse — MERGE restores the
      // original motion_beats[] verbatim so a SPLIT → UNDO → REDO cycle
      // re-slices from the original source instead of from the post-split
      // first-half remnants. `value: undefined` covers the no-beats case.
      const priorMotionBeats: { value: MotionBeat[] | undefined } = {
        value: row.motion_beats,
      };
      // Slice motion_beats[] by the split point. Spanning beats are
      // dropped per `_plans/2026-06-02-shot-split-ui.md` — splitting
      // through an animation is rare and a partial render is worse
      // than a clean drop.
      const beatSlice = sliceMotionBeats(row.motion_beats, firstHalfMs);
      const firstHalf = { ...row, duration_override_ms: firstHalfMs, edited_at: splitStamp };
      // Structural clone with shifted-out duration. Same visual
      // content; the user diverges fields after the split if they
      // want. Both halves carry the same per-category stamp.
      // Both halves get pin_duration: true — splitting is an
      // explicit user duration intent.
      const secondHalf = { ...row, duration_override_ms: secondHalfMs, edited_at: splitStamp };
      // Write the sliced motion_beats onto each half. Undefined means
      // "no beats survived on this side" — delete the field so the row
      // stays clean (mirrors how every other optional field is shaped).
      if (beatSlice.first === undefined) {
        delete (firstHalf as { motion_beats?: MotionBeat[] }).motion_beats;
      } else {
        firstHalf.motion_beats = beatSlice.first;
      }
      if (beatSlice.second === undefined) {
        delete (secondHalf as { motion_beats?: MotionBeat[] }).motion_beats;
      } else {
        secondHalf.motion_beats = beatSlice.second;
      }
      // Detach the second half from any variant group the original row
      // belonged to. Two rows in the same group slot (same group_id +
      // variant_index) would break the variant inspector's resolution
      // and the variant mini-strip's per-row thumbnails. The first
      // half keeps the group membership; the second half becomes a
      // standalone row the user can re-promote or re-attach later.
      const variantDetached = rowHasVariantFields(row);
      if (variantDetached) detachVariantFields(secondHalf);
      applyPinDirective(firstHalf, undefined); // forward: pin = true
      applyPinDirective(secondHalf, undefined);
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
        restorePinDuration: priorPin,
        restoreMotionBeats: priorMotionBeats,
      };
      console.info('[editor split] applied', {
        shotIndex,
        splitAtMs: firstHalfMs,
        secondHalfMs,
        beatsKept: {
          first: beatSlice.first?.length ?? 0,
          second: beatSlice.second?.length ?? 0,
        },
        beatsDropped: beatSlice.dropped,
        variantDetached,
      });
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

    case 'ADD_TEXT_OVERLAY': {
      const overlays = state.doc.text_overlays ?? [];
      const insertAt =
        typeof cmd.insertAtIndex === 'number' &&
        cmd.insertAtIndex >= 0 &&
        cmd.insertAtIndex <= overlays.length
          ? cmd.insertAtIndex
          : overlays.length;
      const nextOverlays = [
        ...overlays.slice(0, insertAt),
        cmd.overlay,
        ...overlays.slice(insertAt),
      ];
      const inverse: EditorCommand = { type: 'DELETE_TEXT_OVERLAY', id: cmd.overlay.id };
      return {
        next: {
          ...state,
          doc: { ...state.doc, text_overlays: nextOverlays },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'UPDATE_TEXT_OVERLAY': {
      const overlays = state.doc.text_overlays ?? [];
      const idx = overlays.findIndex((o) => o.id === cmd.id);
      if (idx === -1) return { next: state, inverse: null };
      const prev = overlays[idx];
      const next = { ...prev, ...cmd.patch };
      // Build the inverse as the SAME patch shape with the prior
      // values for every field the forward patch touched. The
      // `as unknown as Record<...>` casts are unavoidable because
      // keyof on a TextOverlay member isn't structurally compatible
      // with an index signature in TS's variance model.
      const inversePatch: Partial<Omit<TextOverlay, 'id'>> = {};
      const prevAsRecord = prev as unknown as Record<string, unknown>;
      const nextAsRecord = next as unknown as Record<string, unknown>;
      const inverseAsRecord = inversePatch as unknown as Record<string, unknown>;
      const patchKeys = Object.keys(cmd.patch) as Array<keyof Omit<TextOverlay, 'id'>>;
      patchKeys.forEach((k) => {
        inverseAsRecord[k as string] = prevAsRecord[k as string];
      });
      // No-op when nothing actually changed.
      const anyDiff = patchKeys.some((k) => prevAsRecord[k as string] !== nextAsRecord[k as string]);
      if (!anyDiff) return { next: state, inverse: null };
      const nextOverlays = overlays.slice();
      nextOverlays[idx] = next;
      const inverse: EditorCommand = {
        type: 'UPDATE_TEXT_OVERLAY',
        id: cmd.id,
        patch: inversePatch,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, text_overlays: nextOverlays },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'DELETE_TEXT_OVERLAY': {
      const overlays = state.doc.text_overlays ?? [];
      const idx = overlays.findIndex((o) => o.id === cmd.id);
      if (idx === -1) return { next: state, inverse: null };
      const removed = overlays[idx];
      const nextOverlays = overlays.filter((_, i) => i !== idx);
      const inverse: EditorCommand = {
        type: 'ADD_TEXT_OVERLAY',
        overlay: removed,
        insertAtIndex: idx,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, text_overlays: nextOverlays },
          isDirty: true,
        },
        inverse,
      };
    }

    case 'PATCH_ROW': {
      const { rowIndex, patch } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[rowIndex];
      const patchKeys = Object.keys(patch) as Array<keyof typeof row>;
      if (patchKeys.length === 0) {
        return { next: state, inverse: null };
      }
      // Build the next row by walking entries — a patch value of
      // `undefined` DELETES the key (rather than leaving it present
      // with `undefined`, which is what a naive `{...row, ...patch}`
      // would produce). The distinction matters for JSONB save
      // payload size, `in` operator semantics, and React reconciliation
      // of optional fields. The inverse captures the OLD value (which
      // may itself be undefined if the key was absent) — applying the
      // inverse re-deletes the key, so the round-trip is symmetric.
      // We also short-circuit when every patch value already equals
      // the row's current value (true no-op): saves a redundant undo
      // entry and a needless auto-save.
      let anyChange = false;
      const inversePatch: Partial<typeof row> = {};
      const nextRow: typeof row = { ...row };
      for (const key of patchKeys) {
        const oldValue = row[key];
        const newValue = patch[key];
        if (oldValue === newValue) continue;
        anyChange = true;
        (inversePatch as Record<string, unknown>)[key as string] = oldValue;
        // Convert through `unknown` first because TS doesn't believe
        // ProductionRow conforms to Record<string, unknown> (it has
        // no string index signature). The runtime behaviour is the
        // same — JS objects are bag-of-keys regardless of the type.
        const mutable = nextRow as unknown as Record<string, unknown>;
        if (newValue === undefined) {
          delete mutable[key as string];
        } else {
          mutable[key as string] = newValue;
        }
      }
      // 2026-05-23 pin-duration architecture: PATCH_ROW dispatches
      // that touch `duration_override_ms` must also adjust
      // `pin_duration`. A number value sets pin=true (user-intended
      // duration); undefined (clearing the override) clears the pin
      // too. The inverse captures the prior pin so undo restores it.
      // Skipped when the caller has explicitly included pin_duration
      // in the patch — they're in control.
      if ('duration_override_ms' in patch && !('pin_duration' in patch)) {
        const priorPin = row.pin_duration;
        const newPin =
          patch.duration_override_ms !== undefined ? true : undefined;
        if (priorPin !== newPin) {
          anyChange = true;
          (inversePatch as Record<string, unknown>).pin_duration = priorPin;
          const mutable = nextRow as unknown as Record<string, unknown>;
          if (newPin === undefined) {
            delete mutable.pin_duration;
          } else {
            mutable.pin_duration = newPin;
          }
        }
      }
      if (!anyChange) {
        return { next: state, inverse: null };
      }
      const nextRows = state.doc.rows.slice();
      nextRows[rowIndex] = nextRow;
      // Transient patches (e.g. live drag preview) update local state
      // ONLY — no dirty flag (skips autosave) and no undo entry. The
      // non-transient commit fires once at the end of the gesture
      // with the final value and IS persisted.
      if (cmd.transient) {
        return {
          next: { ...state, doc: { ...state.doc, rows: nextRows } },
          inverse: null,
        };
      }
      const inverse: EditorCommand = {
        type: 'PATCH_ROW',
        rowIndex,
        patch: inversePatch,
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

    case 'SET_ROW_OVERLAY': {
      const { rowIndex, overlay, transient } = cmd;
      const prev = state.rowOverlays[rowIndex] ?? null;
      // No-op when the slot's content is unchanged (same reference
      // OR structurally equal). The shallow-equality check below
      // catches the common "same URL + same status" case so a save
      // doesn't fire for what's effectively a re-render.
      if (
        prev === overlay ||
        (prev !== null &&
          overlay !== null &&
          prev.url === overlay.url &&
          prev.status === overlay.status)
      ) {
        return { next: state, inverse: null };
      }
      const nextOverlays = { ...state.rowOverlays };
      if (overlay === null) {
        delete nextOverlays[rowIndex];
      } else {
        nextOverlays[rowIndex] = overlay;
      }
      // Transient changes mark dirty (so save fires) but don't push
      // to undo stack. Used for ephemeral status transitions like
      // `loading` → `done`, where the loading state isn't a user
      // intent the undo should revert to.
      const inverse: EditorCommand | null = transient
        ? null
        : {
            type: 'SET_ROW_OVERLAY',
            rowIndex,
            overlay: prev,
          };
      return {
        next: {
          ...state,
          rowOverlays: nextOverlays,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'ACCEPT_OVERLAY_EDIT': {
      const { rowIndex, newUrl, replacedUrl } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[rowIndex];
      const prevHistory = row.overlay_edit_history ?? [];
      const prevOverlay = state.rowOverlays[rowIndex] ?? null;
      const prevUrl = prevOverlay?.url ?? '';
      // Capacity guard — matches the parents' OVERLAY_EDIT_HISTORY_CAP.
      // Couldn't import it (cyclic), so keep in sync by hand.
      const HISTORY_CAP = 3;
      const nextHistory = [...prevHistory, replacedUrl].slice(-HISTORY_CAP);
      const nextRow = { ...row, overlay_edit_history: nextHistory };
      const nextRows = state.doc.rows.slice();
      nextRows[rowIndex] = nextRow;
      const nextOverlays = {
        ...state.rowOverlays,
        [rowIndex]: { ...(prevOverlay ?? {}), status: 'done', url: newUrl },
      };
      // Inverse: snapshot the FULL prior history (not just length-1)
      // because the cap may have dropped an entry — we need to
      // restore the exact prior array.
      const inverse: EditorCommand = {
        type: 'REVERT_OVERLAY_EDIT_TO',
        rowIndex,
        restoredUrl: prevUrl,
        restoredHistory: prevHistory,
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowOverlays: nextOverlays,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'REVERT_OVERLAY_EDIT_TO': {
      const { rowIndex, restoredUrl, restoredHistory } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[rowIndex];
      const prevHistory = row.overlay_edit_history ?? [];
      const prevOverlay = state.rowOverlays[rowIndex] ?? null;
      const prevUrl = prevOverlay?.url ?? '';
      // Inverse-of-inverse: another REVERT_OVERLAY_EDIT_TO with the
      // current state captured. So Cmd+Z reverses a revert (= redo).
      const inverse: EditorCommand = {
        type: 'REVERT_OVERLAY_EDIT_TO',
        rowIndex,
        restoredUrl: prevUrl,
        restoredHistory: prevHistory,
      };
      const nextRow = { ...row, overlay_edit_history: restoredHistory };
      const nextRows = state.doc.rows.slice();
      nextRows[rowIndex] = nextRow;
      // If restoredUrl is empty (e.g., very first edit had no prior URL),
      // clear the overlay slot rather than setting status:done with ''.
      const nextOverlays = { ...state.rowOverlays };
      if (restoredUrl) {
        nextOverlays[rowIndex] = {
          ...(prevOverlay ?? {}),
          status: 'done',
          url: restoredUrl,
        };
      } else {
        delete nextOverlays[rowIndex];
      }
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowOverlays: nextOverlays,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SET_TRANSITION_IN': {
      const { shotIndex, transition } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[shotIndex];
      const prev = row.transition_in ?? undefined;
      const normalised = transition; // already 'cross-fade' | null
      const prevNormalised = prev === 'cross-fade' ? 'cross-fade' : prev === null ? null : undefined;
      // No-op when nothing changes. `undefined` (never set) is
      // distinct from `null` (explicitly cleared); we only no-op
      // when the proposed value equals the stored one.
      if (prevNormalised === normalised) {
        return { next: state, inverse: null };
      }
      const nextRow = {
        ...row,
        transition_in: normalised ?? undefined,
        edited_at: stampEditedAt(row.edited_at, 'structure'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[shotIndex] = nextRow;
      const inverse: EditorCommand = {
        type: 'SET_TRANSITION_IN',
        shotIndex,
        // Restore the prior value — `undefined` becomes `null` in
        // the inverse because the command type can't represent
        // "undefined" distinctly from "null"; both clear the field.
        transition: prevNormalised === 'cross-fade' ? 'cross-fade' : null,
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

    case 'SET_ROW_VIDEO_CLIP': {
      const { rowIndex, clip, transient } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const prev = state.rowVideoClips[rowIndex] ?? null;
      // No-op short-circuit on a deep-enough equality check. Polling
      // tick that re-reports the same status with the same url would
      // otherwise stamp a redundant entry on every fire.
      //
      // CRITICAL: every field that callers may add over time MUST be
      // compared here. Earlier the check only covered status, videoUrl,
      // durationSeconds — adding brollClipId or errorMessage to an
      // otherwise-equal clip evaluated as 'same' and the reducer
      // returned the OLD state without persisting the new field. That
      // broke the editor's broll polling: handleGenerateClip's second
      // dispatch (with the kickoff's clipId) was silently dropped, so
      // state.rowVideoClips[i].brollClipId stayed undefined and the
      // poll loop never started. Now the check is full-shape — any
      // field difference triggers a write.
      const isSame =
        (prev === null && clip === null) ||
        (prev !== null &&
          clip !== null &&
          prev.status === clip.status &&
          prev.videoUrl === clip.videoUrl &&
          prev.durationSeconds === clip.durationSeconds &&
          prev.brollClipId === clip.brollClipId &&
          prev.errorMessage === clip.errorMessage);
      if (isSame) return { next: state, inverse: null };

      const nextClips = { ...state.rowVideoClips };
      if (clip === null) delete nextClips[rowIndex];
      else nextClips[rowIndex] = clip;

      const inverse: EditorCommand | null = transient
        ? null
        : { type: 'SET_ROW_VIDEO_CLIP', rowIndex, clip: prev, transient: false };

      return {
        next: { ...state, rowVideoClips: nextClips, isDirty: !transient ? true : state.isDirty },
        inverse,
      };
    }

    case 'SET_VISUAL_KIT_OVERRIDE': {
      const prev = state.visualKitOverride;
      const next = cmd.override;
      // Cheap equality check — JSON stringify both sides. The kit is
      // small (≤ 9 fields, all primitives) so this is fine and avoids
      // a "set to identical object" no-op landing on the undo stack.
      if (JSON.stringify(prev) === JSON.stringify(next)) {
        return { next: state, inverse: null };
      }
      return {
        next: { ...state, visualKitOverride: next, isDirty: true },
        inverse: { type: 'SET_VISUAL_KIT_OVERRIDE', override: prev },
      };
    }

    case 'PATCH_DOC': {
      // Shallow merge of doc-level fields. Inverse captures the
      // prior values of EXACTLY the keys being patched so undo
      // reverses only what changed (not the whole doc).
      const patchKeys = Object.keys(cmd.patch) as Array<keyof ProductionDoc>;
      if (patchKeys.length === 0) return { next: state, inverse: null };
      // No-op short-circuit: if every key already matches its
      // current value, skip the dispatch + undo stack entry.
      const anyChanged = patchKeys.some((k) => state.doc[k] !== cmd.patch[k]);
      if (!anyChanged) return { next: state, inverse: null };
      const inversePatch: Partial<ProductionDoc> = {};
      for (const k of patchKeys) {
        // `as never` because TS can't prove the key-type alignment
        // across the dynamic patch; the runtime safety is the
        // key-by-key copy from the same `state.doc` we're reading.
        (inversePatch[k] as never) = state.doc[k] as never;
      }
      return {
        next: {
          ...state,
          doc: { ...state.doc, ...cmd.patch },
          isDirty: true,
        },
        inverse: { type: 'PATCH_DOC', patch: inversePatch },
      };
    }

    case 'SET_VOICEOVER_URL': {
      const prev = state.voiceoverUrl ?? undefined;
      const next = cmd.url && cmd.url.length > 0 ? cmd.url : undefined;
      if (prev === next) return { next: state, inverse: null };
      // Swapping voiceoverUrl invalidates the cached alignment (which
      // was computed against the prior MP3). The user can regen
      // alignment if they want it back; silently clearing it stops
      // the renderer from applying stale word-level timings.
      // The inverse carries the prior alignment so Cmd+Z restores
      // BOTH the URL and the alignment that went with it — otherwise
      // an undo would leave the prior URL with no word-level timings,
      // silently degrading scene-timing realignment.
      const inverse: EditorCommand = {
        type: 'SET_VOICEOVER_URL',
        url: prev ?? null,
        restoreAlignment: state.voiceoverAlignment,
      };
      return {
        next: {
          ...state,
          voiceoverUrl: next,
          // Forward dispatch clears alignment (it's stale vs. the new
          // MP3). Inverse paths carry `restoreAlignment` to put the
          // prior alignment back when Cmd+Z walks the URL backwards.
          voiceoverAlignment: cmd.restoreAlignment,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'UPDATE_CAPTION_SEGMENT': {
      const { segmentIndex, text } = cmd;
      if (!state.captions || segmentIndex < 0 || segmentIndex >= state.captions.segments.length) {
        return { next: state, inverse: null };
      }
      const prevSegment = state.captions.segments[segmentIndex];
      if (prevSegment.text === text) {
        return { next: state, inverse: null };
      }
      const nextSegments = state.captions.segments.slice();
      nextSegments[segmentIndex] = { ...prevSegment, text };
      const nextCaptions: CaptionsBundle = {
        ...state.captions,
        segments: nextSegments,
      };
      const inverse: EditorCommand = {
        type: 'UPDATE_CAPTION_SEGMENT',
        segmentIndex,
        text: prevSegment.text,
      };
      return {
        next: { ...state, captions: nextCaptions, isDirty: true },
        inverse,
      };
    }

    case 'SET_CAPTION_SEGMENT_TIMING': {
      const { segmentIndex, startSeconds, endSeconds } = cmd;
      if (
        !state.captions ||
        segmentIndex < 0 ||
        segmentIndex >= state.captions.segments.length
      ) {
        return { next: state, inverse: null };
      }
      // Reject negative / zero-duration / inverted ranges. The
      // caller is responsible for computing a sane (start, end);
      // the reducer just refuses to corrupt the segment.
      if (
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        startSeconds < 0 ||
        endSeconds <= startSeconds
      ) {
        console.warn('[editor store] caption-timing rejected', {
          segmentIndex,
          startSeconds,
          endSeconds,
        });
        return { next: state, inverse: null };
      }
      const prev = state.captions.segments[segmentIndex];
      if (prev.start === startSeconds && prev.end === endSeconds) {
        return { next: state, inverse: null };
      }
      const nextSegments = state.captions.segments.slice();
      nextSegments[segmentIndex] = {
        ...prev,
        start: startSeconds,
        end: endSeconds,
      };
      const nextCaptions: CaptionsBundle = {
        ...state.captions,
        segments: nextSegments,
      };
      const inverse: EditorCommand = {
        type: 'SET_CAPTION_SEGMENT_TIMING',
        segmentIndex,
        startSeconds: prev.start,
        endSeconds: prev.end,
      };
      return {
        next: { ...state, captions: nextCaptions, isDirty: true },
        inverse,
      };
    }

    case 'SET_FLAGS': {
      // Doc-level flag toggle (animateScenes / suppressLowerThirds /
      // overlaysDisabled / rowLockedAsStill). Merges the partial into
      // the current flags; the inverse is the prior flags so undo
      // restores exactly the previous configuration even for
      // partial-key toggles.
      const prev = state.flags;
      const merged: ProjectPayloadFlags = {
        animateScenes:
          cmd.flags.animateScenes !== undefined ? cmd.flags.animateScenes : prev.animateScenes,
        suppressLowerThirds:
          cmd.flags.suppressLowerThirds !== undefined
            ? cmd.flags.suppressLowerThirds
            : prev.suppressLowerThirds,
        overlaysDisabled:
          cmd.flags.overlaysDisabled !== undefined
            ? cmd.flags.overlaysDisabled
            : prev.overlaysDisabled,
        rowLockedAsStill:
          cmd.flags.rowLockedAsStill !== undefined
            ? cmd.flags.rowLockedAsStill
            : prev.rowLockedAsStill,
      };
      // No-op short-circuit so the undo stack doesn't grow with
      // "toggle" entries that don't actually change anything.
      if (
        merged.animateScenes === prev.animateScenes &&
        merged.suppressLowerThirds === prev.suppressLowerThirds &&
        merged.overlaysDisabled === prev.overlaysDisabled &&
        merged.rowLockedAsStill === prev.rowLockedAsStill
      ) {
        return { next: state, inverse: null };
      }
      return {
        next: { ...state, flags: merged, isDirty: true },
        inverse: { type: 'SET_FLAGS', flags: prev },
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
        // CapCut ripple semantics. The naive splice (which is what
        // this branch used to do) breaks because row durations are
        // derived from inter-row timecode deltas — after a splice,
        // the left neighbor's `next` jumps forward and its natural
        // duration balloons. To preserve every surviving row's
        // visual width, we do three things before splicing:
        //
        //   1. Lock the LEFT neighbor's duration (stamp
        //      duration_override_ms = its current renderer-effective
        //      duration) if it doesn't already have an override.
        //   2. Lock the LAST row's duration the same way. Its
        //      natural-duration formula is `totalDur - lastRow.tc`,
        //      which grows when later timecodes shift left (step 3).
        //   3. Shift every row at index > shotIndex left by the
        //      deleted row's effective duration — that's the visible
        //      "ripple" the user expects.
        //
        // The inverse RESTORE_ROW captures each modification so undo
        // restores the prior shape exactly. See
        // `_plans/2026-06-07-ripple-delete-capcut-semantics.md`.
        const deletedEffMs =
          parseTimecodeMs(row.timecode) === null
            ? 0 // row has no timeline footprint; nothing to ripple
            : rendererEffectiveDurationMs(state.doc, shotIndex);
        const lastIndexBefore = state.doc.rows.length - 1;
        const leftNeighborIdx = shotIndex - 1;
        const stampOverrideIndices = new Set<number>();
        // Only stamp when the deletion actually ripples AND the
        // candidate has a parseable timecode AND no existing override.
        // Empty-timecode rows (decorative variants, hand-added blanks)
        // don't participate in the cascade in a way that triggers the
        // neighbor-balloon bug — stamping them would invent a 2s slot
        // they previously didn't render with.
        const isStampable = (i: number): boolean => {
          const r = state.doc.rows[i];
          if (typeof r.duration_override_ms === 'number') return false;
          return parseTimecodeMs(r.timecode) !== null;
        };
        if (deletedEffMs > 0) {
          if (leftNeighborIdx >= 0 && isStampable(leftNeighborIdx)) {
            stampOverrideIndices.add(leftNeighborIdx);
          }
          if (
            lastIndexBefore !== shotIndex
            && lastIndexBefore !== leftNeighborIdx
            && isStampable(lastIndexBefore)
          ) {
            stampOverrideIndices.add(lastIndexBefore);
          }
        }
        // Build a working rows array with stamps + shifts applied,
        // then splice out the deleted row. Record each modification so
        // the inverse can undo it. Pre-splice index == post-restore
        // index for every entry: rows at i < shotIndex are unchanged
        // by both splice and re-insert; rows at i > shotIndex are
        // shifted -1 by splice and +1 by re-insert, netting to i.
        const restoreEntries: Array<{
          rowIndex: number;
          prevTimecode?: string;
          prevDurationOverrideMs?: number;
          clearDurationOverride?: boolean;
        }> = [];
        const workingRows = state.doc.rows.map((r, i) => {
          if (i === shotIndex) return r;
          let nextRow = r;
          const stampHere = stampOverrideIndices.has(i);
          if (stampHere) {
            nextRow = {
              ...nextRow,
              duration_override_ms: rendererEffectiveDurationMs(state.doc, i),
            };
          }
          const shiftHere = i > shotIndex && deletedEffMs > 0;
          if (shiftHere) {
            const shiftedTc = shiftTimecodeMs(nextRow.timecode, deletedEffMs);
            if (shiftedTc !== nextRow.timecode) {
              nextRow = { ...nextRow, timecode: shiftedTc };
            }
          }
          if (stampHere || (shiftHere && nextRow.timecode !== r.timecode)) {
            const entry: {
              rowIndex: number;
              prevTimecode?: string;
              prevDurationOverrideMs?: number;
              clearDurationOverride?: boolean;
            } = { rowIndex: i };
            if (shiftHere && nextRow.timecode !== r.timecode) {
              entry.prevTimecode = r.timecode;
            }
            if (stampHere) {
              if (typeof r.duration_override_ms === 'number') {
                entry.prevDurationOverrideMs = r.duration_override_ms;
              } else {
                entry.clearDurationOverride = true;
              }
            }
            restoreEntries.push(entry);
          }
          return nextRow;
        });
        const nextRows = [
          ...workingRows.slice(0, shotIndex),
          ...workingRows.slice(shotIndex + 1),
        ];
        const nextImages = reindexRowImages(state.rowImages, shotIndex, -1);
        const inverse: EditorCommand = {
          type: 'RESTORE_ROW',
          atIndex: shotIndex,
          row,
          rowImageUrl,
          mode: 'insert',
          ...(restoreEntries.length > 0 ? { restoreRowFields: restoreEntries } : {}),
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
        console.info('[editor delete-shot ripple]', {
          shotIndex,
          deletedDurationMs: deletedEffMs,
          stampedLeftNeighbor: stampOverrideIndices.has(leftNeighborIdx),
          stampedLastRow:
            lastIndexBefore !== shotIndex
            && lastIndexBefore !== leftNeighborIdx
            && stampOverrideIndices.has(lastIndexBefore),
          shiftedTimecodeCount: Math.max(0, state.doc.rows.length - 1 - shotIndex),
        });
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
        const inserted = [
          ...state.doc.rows.slice(0, atIndex),
          row,
          ...state.doc.rows.slice(atIndex),
        ];
        // Apply per-row field restorations recorded by the original
        // ripple delete (timecodes shifted left + duration overrides
        // stamped on the left neighbor + last row). Indices in
        // restoreRowFields are post-restore — i.e., they index into
        // `inserted` directly.
        const nextRows = cmd.restoreRowFields && cmd.restoreRowFields.length > 0
          ? inserted.map((r, i) => {
              const entry = cmd.restoreRowFields!.find((e) => e.rowIndex === i);
              if (!entry) return r;
              let next = r;
              if (entry.prevTimecode !== undefined) {
                next = { ...next, timecode: entry.prevTimecode };
              }
              if (entry.clearDurationOverride) {
                const { duration_override_ms: _drop, ...rest } = next;
                void _drop;
                next = rest as typeof next;
              } else if (typeof entry.prevDurationOverrideMs === 'number') {
                next = { ...next, duration_override_ms: entry.prevDurationOverrideMs };
              }
              return next;
            })
          : inserted;
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

    case 'DUPLICATE_SHOT': {
      const { shotIndex } = cmd;
      if (shotIndex < 0 || shotIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const sourceRow = state.doc.rows[shotIndex];
      // Stamp edited_at so downstream observers (auto-pipeline,
      // analytics) see this as a fresh row, not the same source
      // row at a new index. Same pattern DELETE_SHOT 'blank' uses.
      const clonedRow: ProductionDoc['rows'][number] = {
        ...sourceRow,
        edited_at: stampEditedAt(sourceRow.edited_at, 'structure'),
      };
      const insertAtIndex = shotIndex + 1;
      const nextRows = [
        ...state.doc.rows.slice(0, insertAtIndex),
        clonedRow,
        ...state.doc.rows.slice(insertAtIndex),
      ];
      // Reindex every rowImages key ≥ insertAtIndex up by one, then
      // copy the source row's image (if any) into the new slot so
      // the clone shows the same visual until the user regenerates.
      let nextImages = reindexRowImages(state.rowImages, insertAtIndex, 1);
      const sourceImageUrl = state.rowImages[shotIndex];
      if (sourceImageUrl) {
        nextImages = { ...nextImages, [insertAtIndex]: sourceImageUrl };
      }
      // Same reindex for rowOverlays + rowVideoClips so per-row
      // state stays attached to the right rows after the splice.
      // We deliberately do NOT copy overlay / clip state into the
      // new slot — those are heavyweight per-row computed artifacts
      // that should regenerate against the cloned prompt rather
      // than be aliased to the source row's outputs.
      const nextOverlays = reindexRecord(state.rowOverlays, insertAtIndex, 1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, insertAtIndex, 1);
      const inverse: EditorCommand = {
        type: 'DELETE_SHOT',
        shotIndex: insertAtIndex,
        mode: 'ripple',
      };
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          // Select the clone so the user can start tweaking it.
          selection: insertAtIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'INSERT_BLANK_SHOT': {
      const { atIndex, mode, durationMs, carveFrom } = cmd;
      // Valid insertion range is [0, rows.length]; rows.length appends.
      if (atIndex < 0 || atIndex > state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const clampedDurationMs = Math.min(
        EDITOR_MAX_SHOT_MS,
        Math.max(EDITOR_MIN_SHOT_MS, Math.round(durationMs)),
      );

      // Carve mode: pick a neighbor with ≥ 2 × MIN_SHOT_MS effective
      // duration (one MIN for itself post-carve, one MIN for what we're
      // giving away) and reduce its override by the carve amount. Shift
      // mode: leave neighbors alone, new row just extends total length.
      let newRowDurationMs = clampedDurationMs;
      let neighborMutation: {
        rowIndex: number;
        priorOverride: number | null;
        nextOverride: number;
      } | null = null;

      if (mode === 'carve') {
        const candidate = (i: number) => {
          if (i < 0 || i >= state.doc.rows.length) return null;
          const r = state.doc.rows[i];
          const override =
            typeof r.duration_override_ms === 'number' ? r.duration_override_ms : null;
          const eff = override ?? naturalRowDurationMs(state.doc, i);
          return { idx: i, eff, override };
        };
        // Left neighbor sits at atIndex - 1; right neighbor at atIndex
        // BEFORE the splice (it'll move to atIndex + 1 after insert).
        const left = candidate(atIndex - 1);
        const right = candidate(atIndex);
        // Need ≥ 2 × floor so we can give MIN_SHOT_MS and keep MIN_SHOT_MS.
        const canGive = (n: { eff: number } | null) =>
          n !== null && n.eff >= 2 * EDITOR_MIN_SHOT_MS;
        const preferred = carveFrom ?? 'auto';
        let chosen: { idx: number; eff: number; override: number | null } | null = null;
        if (preferred === 'auto') {
          if (canGive(left) && canGive(right)) {
            chosen = left!.eff >= right!.eff ? left : right;
          } else if (canGive(left)) {
            chosen = left;
          } else if (canGive(right)) {
            chosen = right;
          }
        } else if (preferred === 'left') {
          chosen = canGive(left) ? left : canGive(right) ? right : null;
        } else {
          chosen = canGive(right) ? right : canGive(left) ? left : null;
        }
        if (!chosen) {
          console.warn('[editor store] insert-blank-shot carve no-op — no neighbor with slack', {
            atIndex,
            leftMs: left?.eff,
            rightMs: right?.eff,
            requiredEffMs: 2 * EDITOR_MIN_SHOT_MS,
          });
          return { next: state, inverse: null };
        }
        // min() handles the case where the chosen neighbor has less
        // slack than the requested carve; we take what's available and
        // the new row's duration matches what was actually carved.
        const maxCarve = chosen.eff - EDITOR_MIN_SHOT_MS;
        const actualCarve = Math.min(clampedDurationMs, maxCarve);
        newRowDurationMs = actualCarve;
        neighborMutation = {
          rowIndex: chosen.idx,
          priorOverride: chosen.override,
          nextOverride: chosen.eff - actualCarve,
        };
      }

      // Build the new blank row + apply optional neighbor mutation.
      // The carved neighbor gets pin_duration: true — the user's
      // insert intent extends to the row whose duration we just
      // changed. Capture its prior pin state for undo.
      const newRow = makeBlankRow(newRowDurationMs);
      const mutatedRows = state.doc.rows.slice();
      const priorNeighborPin = neighborMutation
        ? capturePinState(state.doc.rows[neighborMutation.rowIndex])
        : undefined;
      if (neighborMutation) {
        const n = mutatedRows[neighborMutation.rowIndex];
        const updated = {
          ...n,
          duration_override_ms: neighborMutation.nextOverride,
          edited_at: stampEditedAt(n.edited_at, 'duration'),
        };
        applyPinDirective(updated, undefined); // forward: pin = true
        mutatedRows[neighborMutation.rowIndex] = updated;
      }
      const nextRows = [
        ...mutatedRows.slice(0, atIndex),
        newRow,
        ...mutatedRows.slice(atIndex),
      ];

      // Reindex all three per-row maps so existing rows stay attached
      // to their assets after the splice. DUPLICATE_SHOT does the same.
      const nextImages = reindexRowImages(state.rowImages, atIndex, 1);
      const nextOverlays = reindexRecord(state.rowOverlays, atIndex, 1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, atIndex, 1);

      const inverse: EditorCommand = {
        type: 'REMOVE_INSERTED_SHOT',
        atIndex,
        // restoreNeighbor.rowIndex is the POST-insert position of the
        // carved neighbor (the inverse handler runs against the post-
        // insert state). Left neighbor: pre-insert = atIndex - 1, post
        // = atIndex - 1 (the splice happens to its right, so its index
        // is unchanged). Right neighbor: pre-insert = atIndex, post =
        // atIndex + 1 (the splice pushed it one slot right).
        restoreNeighbor: neighborMutation
          ? {
              rowIndex:
                neighborMutation.rowIndex < atIndex
                  ? neighborMutation.rowIndex
                  : neighborMutation.rowIndex + 1,
              value: neighborMutation.priorOverride,
              restorePin: priorNeighborPin,
            }
          : undefined,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: atIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'REMOVE_INSERTED_SHOT': {
      const { atIndex, restoreNeighbor } = cmd;
      if (atIndex < 0 || atIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      // Refuse to empty the doc — mirrors the DELETE_SHOT guard above.
      // Wouldn't normally fire as an inverse (you can't have inserted
      // INTO an empty doc) but defends against direct dispatch.
      if (state.doc.rows.length === 1) {
        console.warn('[editor store] remove-inserted-shot refused — can\'t empty the doc');
        return { next: state, inverse: null };
      }

      // Capture the to-be-removed row's effective duration BEFORE the
      // splice — the redo INSERT_BLANK_SHOT needs it to reproduce
      // this state.
      const rowToRemove = state.doc.rows[atIndex];
      const removedDurationMs =
        typeof rowToRemove.duration_override_ms === 'number'
          ? rowToRemove.duration_override_ms
          : naturalRowDurationMs(state.doc, atIndex);

      const mutatedRows = state.doc.rows.slice();
      if (restoreNeighbor) {
        const { rowIndex, value, restorePin } = restoreNeighbor;
        if (rowIndex >= 0 && rowIndex < mutatedRows.length) {
          const neighbor = mutatedRows[rowIndex];
          const copy = { ...neighbor };
          if (value === null) {
            delete copy.duration_override_ms;
          } else {
            copy.duration_override_ms = value;
          }
          // Restore prior pin state (may be undefined ⇒ clear, may
          // be a boolean). When restorePin is absent the inverse
          // was built before the pin-duration feature shipped —
          // leave pin_duration as-is.
          if (restorePin !== undefined) {
            applyPinDirective(copy, restorePin);
          }
          mutatedRows[rowIndex] = copy;
        }
      }
      const nextRows = [
        ...mutatedRows.slice(0, atIndex),
        ...mutatedRows.slice(atIndex + 1),
      ];

      const nextImages = reindexRowImages(state.rowImages, atIndex, -1);
      const nextOverlays = reindexRecord(state.rowOverlays, atIndex, -1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, atIndex, -1);

      // Selection follows the same rules as DELETE_SHOT ripple.
      let nextSelection = state.selection;
      if (nextSelection !== null) {
        if (nextSelection === atIndex) {
          nextSelection = nextRows.length === 0 ? null : Math.min(atIndex, nextRows.length - 1);
        } else if (nextSelection > atIndex) {
          nextSelection -= 1;
        }
      }

      // Redo path: reconstruct the original INSERT_BLANK_SHOT. carveFrom
      // is derived from where the restored neighbor sits relative to
      // the insertion point (rowIndex < atIndex ⇒ left was carved;
      // rowIndex > atIndex ⇒ right was carved). rowIndex === atIndex
      // is impossible — that index was the inserted row itself.
      const inverse: EditorCommand = {
        type: 'INSERT_BLANK_SHOT',
        atIndex,
        mode: restoreNeighbor ? 'carve' : 'shift',
        durationMs: removedDurationMs,
        carveFrom: restoreNeighbor
          ? restoreNeighbor.rowIndex < atIndex
            ? 'left'
            : 'right'
          : undefined,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: nextSelection,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'MERGE_ADJACENT_SHOTS': {
      const { shotIndex, restoredDurationOverrideMs, restorePinDuration, restoreMotionBeats } = cmd;
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
      // Forward-path MERGE: pin the merged row (the user's merge is
      // an explicit duration intent). Inverse path (undo-of-SPLIT):
      // restorePinDuration carries the pre-split pin state — apply
      // it so the original row's shape is restored exactly.
      applyPinDirective(restored, restorePinDuration);
      // Inverse-path MERGE only: restoreMotionBeats carries the
      // pre-split motion_beats[] verbatim so a SPLIT → UNDO → REDO
      // cycle re-slices from the same source. Absent ⇒ legacy inverse
      // from before the motion-beat slice feature; leave the merged
      // row's beats as-is. value: undefined ⇒ pre-split row had no
      // beats; clear the field.
      if (restoreMotionBeats !== undefined) {
        if (restoreMotionBeats.value === undefined) {
          delete (restored as { motion_beats?: MotionBeat[] }).motion_beats;
        } else {
          restored.motion_beats = restoreMotionBeats.value;
        }
      }
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

    case 'ADD_VARIANT_ROW': {
      const { baseIndex } = cmd;
      if (baseIndex < 0 || baseIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const baseRow = state.doc.rows[baseIndex];
      const existingGroupId = baseRow.group_id;
      const groupId =
        existingGroupId
        ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

      // The base counts as a group member even when it hasn't been
      // promoted yet — the cap (4 = 1 base + 3 variants) is for the
      // post-add state, so the predicate is "is the group already at
      // the ceiling BEFORE we add."
      const groupRows = state.doc.rows.filter((r) => r.group_id === groupId);
      const currentSize = existingGroupId ? groupRows.length : 1;
      if (currentSize >= MAX_VARIANTS_PER_GROUP) {
        console.warn('[editor store] add-variant refused — group at cap', {
          baseIndex,
          groupId,
          cap: MAX_VARIANTS_PER_GROUP,
        });
        return { next: state, inverse: null };
      }
      const nextVariantIndex = existingGroupId
        ? Math.max(...groupRows.map((r) => r.variant_index ?? 0)) + 1
        : 1;

      // Capture pre-mutation state of the base for the inverse so we
      // can restore a TRUE standalone row on undo (not just delete the
      // variant and leave the base with a dangling group_id).
      const wasStandalone = !existingGroupId;
      const priorBaseGroupId = baseRow.group_id;
      const priorBaseVariantIndex = baseRow.variant_index;
      const priorBaseGroupChainDefault = baseRow.group_variant_chain_default;

      const rowsWithBasePromoted = wasStandalone
        ? state.doc.rows.map((r, i) =>
            i === baseIndex
              ? { ...r, group_id: groupId, variant_index: 0 }
              : r,
          )
        : state.doc.rows.slice();

      // Insert right after the LAST member of the group — variants are
      // contiguous after the base in the row list (a production-doc
      // invariant). Scanning until the first row whose group_id differs
      // lands us at the slot just past the group's tail.
      let lastGroupIndex = baseIndex;
      for (let i = baseIndex + 1; i < rowsWithBasePromoted.length; i++) {
        if (rowsWithBasePromoted[i]?.group_id === groupId) {
          lastGroupIndex = i;
        } else {
          break;
        }
      }
      const insertAt = lastGroupIndex + 1;

      // Chain-mode resolution mirrors the runtime tier order in
      // remotion/utils.ts:653 (per-variant > base default > doc default).
      const groupChainDefault = baseRow.group_variant_chain_default;
      let chainedDefault: boolean | undefined;
      if (groupChainDefault === 'chained') chainedDefault = true;
      else if (groupChainDefault === 'parallel') chainedDefault = false;
      else if (state.doc.variants_chained_by_default === true) chainedDefault = true;

      const newRow: ProductionDoc['rows'][number] = {
        timecode: '',
        script_text: '',
        visual_type: baseRow.visual_type,
        visual_description: baseRow.visual_description,
        stock_search_terms: baseRow.stock_search_terms,
        // Empty by design — the edit dispatcher composes the actual
        // generation prompt from base.ai_image_prompt + this row's
        // variant_edit_prompt. A non-empty ai_image_prompt here would
        // confuse the prompt-composition path.
        ai_image_prompt: '',
        on_screen_text: '',
        notes: '',
        group_id: groupId,
        variant_index: nextVariantIndex,
        variant_edit_prompt: '',
        ...(chainedDefault !== undefined
          ? { variant_derives_from_previous: chainedDefault }
          : {}),
        edited_at: stampEditedAt(undefined, 'structure'),
      };

      const nextRows = [
        ...rowsWithBasePromoted.slice(0, insertAt),
        newRow,
        ...rowsWithBasePromoted.slice(insertAt),
      ];
      const nextImages = reindexRowImages(state.rowImages, insertAt, 1);
      const nextOverlays = reindexRecord(state.rowOverlays, insertAt, 1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, insertAt, 1);

      const inverse: EditorCommand = {
        type: 'REVERT_ADD_VARIANT_ROW',
        variantIndex: insertAt,
        restoreBase: wasStandalone
          ? {
              rowIndex: baseIndex,
              priorGroupId: priorBaseGroupId,
              priorVariantIndex: priorBaseVariantIndex,
              priorGroupChainDefault: priorBaseGroupChainDefault,
            }
          : undefined,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: insertAt,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'REVERT_ADD_VARIANT_ROW': {
      const { variantIndex, restoreBase } = cmd;
      if (variantIndex < 0 || variantIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      if (state.doc.rows.length === 1) {
        console.warn('[editor store] revert-add-variant refused — can\'t empty the doc');
        return { next: state, inverse: null };
      }
      const removedRow = state.doc.rows[variantIndex];
      const removedImageUrl = state.rowImages[variantIndex] ?? null;
      const baseIndexForRedo = restoreBase?.rowIndex ?? -1;

      const mutatedRows = state.doc.rows.slice();
      if (restoreBase) {
        const { rowIndex, priorGroupId, priorVariantIndex, priorGroupChainDefault } = restoreBase;
        if (rowIndex >= 0 && rowIndex < mutatedRows.length) {
          const copy = { ...mutatedRows[rowIndex] };
          if (priorGroupId === undefined) delete copy.group_id;
          else copy.group_id = priorGroupId;
          if (priorVariantIndex === undefined) delete copy.variant_index;
          else copy.variant_index = priorVariantIndex;
          if (priorGroupChainDefault === undefined) delete copy.group_variant_chain_default;
          else copy.group_variant_chain_default = priorGroupChainDefault;
          mutatedRows[rowIndex] = copy;
        }
      }
      const nextRows = [
        ...mutatedRows.slice(0, variantIndex),
        ...mutatedRows.slice(variantIndex + 1),
      ];
      const nextImages = reindexRowImages(state.rowImages, variantIndex, -1);
      const nextOverlays = reindexRecord(state.rowOverlays, variantIndex, -1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, variantIndex, -1);

      let nextSelection = state.selection;
      if (nextSelection !== null) {
        if (nextSelection === variantIndex) {
          nextSelection = baseIndexForRedo >= 0
            ? baseIndexForRedo
            : Math.min(variantIndex, nextRows.length - 1);
        } else if (nextSelection > variantIndex) {
          nextSelection -= 1;
        }
      }

      // Redo (forward of the original ADD_VARIANT_ROW): when restoreBase
      // is present the original add was the first-promotion case, so the
      // redo targets the base at its restored index. When absent, the
      // original add extended an existing group — the new variant landed
      // right after the previous tail, and the base sits earlier.
      // In both cases the redo's `baseIndex` is the row whose group the
      // variant belongs to; we look it up from the removed row.
      let redoBaseIndex = baseIndexForRedo;
      if (redoBaseIndex < 0 && removedRow.group_id) {
        const idx = nextRows.findIndex(
          (r) => r.group_id === removedRow.group_id && (r.variant_index ?? 0) === 0,
        );
        if (idx >= 0) redoBaseIndex = idx;
      }
      const inverse: EditorCommand = {
        type: 'ADD_VARIANT_ROW',
        baseIndex: redoBaseIndex >= 0 ? redoBaseIndex : variantIndex - 1,
      };

      void removedImageUrl; // captured for symmetry with DELETE_VARIANT_ROW; not used here
      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: nextSelection,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'DELETE_VARIANT_ROW': {
      const { rowIndex } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const target = state.doc.rows[rowIndex];
      const groupId = target.group_id;
      // Guard: only variant rows (variant_index > 0) flow through here.
      // Refuse on base rows + standalone rows so a misrouted dispatch
      // can't silently corrupt a group.
      if (!groupId || (target.variant_index ?? 0) === 0) {
        console.warn('[editor store] delete-variant refused — not a variant row', {
          rowIndex,
          group_id: target.group_id,
          variant_index: target.variant_index,
        });
        return { next: state, inverse: null };
      }
      if (state.doc.rows.length === 1) {
        console.warn('[editor store] delete-variant refused — can\'t empty the doc');
        return { next: state, inverse: null };
      }

      const rowImageUrl = state.rowImages[rowIndex] ?? null;
      // CapCut ripple semantics — same pattern DELETE_SHOT applies.
      // Variants typically carry empty timecodes (per ADD_VARIANT_ROW
      // at line ~2807) and are decorative on the timeline. When the
      // deleted row has no parseable timecode it doesn't contribute a
      // ripple, so we skip the stamp/shift bookkeeping entirely — that
      // keeps decorative variants from sprouting unwanted duration
      // overrides on their neighbors. Kept symmetric with DELETE_SHOT
      // so a variant with an explicit timecode (rare but possible —
      // user-edited or imported) doesn't trigger the neighbor-balloon
      // bug.
      const deletedEffMs =
        parseTimecodeMs(target.timecode) === null
          ? 0
          : rendererEffectiveDurationMs(state.doc, rowIndex);
      const lastIndexBefore = state.doc.rows.length - 1;
      const leftNeighborIdx = rowIndex - 1;
      const stampOverrideIndices = new Set<number>();
      // Only stamp when the deletion actually ripples (deletedEffMs > 0)
      // AND the candidate has a parseable timecode AND no existing
      // override.
      const isStampable = (i: number): boolean => {
        const r = state.doc.rows[i];
        if (typeof r.duration_override_ms === 'number') return false;
        return parseTimecodeMs(r.timecode) !== null;
      };
      if (deletedEffMs > 0) {
        if (leftNeighborIdx >= 0 && isStampable(leftNeighborIdx)) {
          stampOverrideIndices.add(leftNeighborIdx);
        }
        if (
          lastIndexBefore !== rowIndex
          && lastIndexBefore !== leftNeighborIdx
          && isStampable(lastIndexBefore)
        ) {
          stampOverrideIndices.add(lastIndexBefore);
        }
      }
      const restoreEntries: Array<{
        rowIndex: number;
        prevTimecode?: string;
        prevDurationOverrideMs?: number;
        clearDurationOverride?: boolean;
      }> = [];
      const workingRows = state.doc.rows.map((r, i) => {
        if (i === rowIndex) return r;
        let nextRow = r;
        const stampHere = stampOverrideIndices.has(i);
        if (stampHere) {
          nextRow = {
            ...nextRow,
            duration_override_ms: rendererEffectiveDurationMs(state.doc, i),
          };
        }
        const shiftHere = i > rowIndex && deletedEffMs > 0;
        if (shiftHere) {
          const shiftedTc = shiftTimecodeMs(nextRow.timecode, deletedEffMs);
          if (shiftedTc !== nextRow.timecode) {
            nextRow = { ...nextRow, timecode: shiftedTc };
          }
        }
        if (stampHere || (shiftHere && nextRow.timecode !== r.timecode)) {
          const entry: {
            rowIndex: number;
            prevTimecode?: string;
            prevDurationOverrideMs?: number;
            clearDurationOverride?: boolean;
          } = { rowIndex: i };
          if (shiftHere && nextRow.timecode !== r.timecode) {
            entry.prevTimecode = r.timecode;
          }
          if (stampHere) {
            if (typeof r.duration_override_ms === 'number') {
              entry.prevDurationOverrideMs = r.duration_override_ms;
            } else {
              entry.clearDurationOverride = true;
            }
          }
          restoreEntries.push(entry);
        }
        return nextRow;
      });

      // Remove + re-number remaining variants so indices are 1..N-1 with
      // no gaps. Base (variant_index === 0) stays at 0. Mirrors the
      // production-doc grid's deleteVariantRow.
      const without = workingRows.filter((_, i) => i !== rowIndex);
      let seen = 0;
      const reindexed = without.map((r) => {
        if (r.group_id !== groupId) return r;
        if ((r.variant_index ?? 0) === 0) return r;
        seen += 1;
        return { ...r, variant_index: seen };
      });

      const nextImages = reindexRowImages(state.rowImages, rowIndex, -1);
      const nextOverlays = reindexRecord(state.rowOverlays, rowIndex, -1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, rowIndex, -1);

      let nextSelection = state.selection;
      if (nextSelection !== null) {
        if (nextSelection === rowIndex) {
          nextSelection = Math.min(rowIndex, reindexed.length - 1);
        } else if (nextSelection > rowIndex) {
          nextSelection -= 1;
        }
      }

      const inverse: EditorCommand = {
        type: 'RESTORE_VARIANT_ROW',
        atIndex: rowIndex,
        // Snapshot the row WITH its original variant_index — the
        // restore handler re-inserts it and re-applies the variant
        // numbering so the remaining variants slot back into 1..N.
        row: target,
        rowImageUrl,
        ...(restoreEntries.length > 0 ? { restoreRowFields: restoreEntries } : {}),
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: reindexed },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: nextSelection,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'RESTORE_VARIANT_ROW': {
      const { atIndex, row, rowImageUrl } = cmd;
      if (atIndex < 0 || atIndex > state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const groupId = row.group_id;
      const variantIdx = row.variant_index ?? 0;
      if (!groupId || variantIdx === 0) {
        // Only restorable as a variant. A misshapen inverse would be a
        // bug elsewhere; refuse rather than corrupt the group.
        console.warn('[editor store] restore-variant refused — not a variant row payload');
        return { next: state, inverse: null };
      }

      // Re-insert the row at its original index. The reducer's caller
      // is the undo path of DELETE_VARIANT_ROW, where deletion re-
      // numbered the remaining variants downward. To put the restored
      // variant back into the right slot we re-bump every later
      // variant in the group whose variant_index >= the restored value.
      const withRestored = [
        ...state.doc.rows.slice(0, atIndex),
        row,
        ...state.doc.rows.slice(atIndex),
      ];
      const reindexed = withRestored.map((r, i) => {
        if (i === atIndex) return r;
        if (r.group_id !== groupId) return r;
        const idx = r.variant_index ?? 0;
        if (idx >= variantIdx) return { ...r, variant_index: idx + 1 };
        return r;
      });
      // Replay the neighbor timecode + override restorations stamped
      // by the forward DELETE_VARIANT_ROW. Mirrors RESTORE_ROW's
      // restoreRowFields handling so undo round-trips cleanly even
      // when the deleted variant carried an explicit timecode.
      const finalRows = cmd.restoreRowFields && cmd.restoreRowFields.length > 0
        ? reindexed.map((r, i) => {
            const entry = cmd.restoreRowFields!.find((e) => e.rowIndex === i);
            if (!entry) return r;
            let next = r;
            if (entry.prevTimecode !== undefined) {
              next = { ...next, timecode: entry.prevTimecode };
            }
            if (entry.clearDurationOverride) {
              const { duration_override_ms: _drop, ...rest } = next;
              void _drop;
              next = rest as typeof next;
            } else if (typeof entry.prevDurationOverrideMs === 'number') {
              next = { ...next, duration_override_ms: entry.prevDurationOverrideMs };
            }
            return next;
          })
        : reindexed;

      let nextImages = reindexRowImages(state.rowImages, atIndex, 1);
      if (rowImageUrl !== null) {
        nextImages = { ...nextImages, [atIndex]: rowImageUrl };
      }
      const nextOverlays = reindexRecord(state.rowOverlays, atIndex, 1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, atIndex, 1);

      const inverse: EditorCommand = {
        type: 'DELETE_VARIANT_ROW',
        rowIndex: atIndex,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: finalRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: atIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'MOVE_VARIANT_ROW': {
      const { rowIndex, direction } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const target = state.doc.rows[rowIndex];
      const groupId = target.group_id;
      const targetIdx = target.variant_index ?? 0;
      // Only swap variants (idx >= 1) with siblings in the same group.
      // Refuse base / standalone rows + cross-group swaps so the
      // variant_index sequence stays consistent.
      if (!groupId || targetIdx === 0) {
        return { next: state, inverse: null };
      }
      const swapIdx = direction === 'up' ? targetIdx - 1 : targetIdx + 1;
      if (swapIdx < 1) {
        // Can't move past the base — that would re-number the base to 1
        // and silently corrupt the group's structure.
        return { next: state, inverse: null };
      }
      const swapRowIndex = state.doc.rows.findIndex(
        (r) => r.group_id === groupId && (r.variant_index ?? 0) === swapIdx,
      );
      if (swapRowIndex < 0) {
        return { next: state, inverse: null };
      }

      const nextRows = state.doc.rows.slice();
      const a = { ...nextRows[rowIndex], variant_index: swapIdx };
      const b = { ...nextRows[swapRowIndex], variant_index: targetIdx };
      nextRows[rowIndex] = b;
      nextRows[swapRowIndex] = a;

      // Swap the asset map entries for the two positions so each
      // variant's image / overlay / clip rides with it.
      const swapEntry = <V,>(rec: Record<number, V>): Record<number, V> => {
        const next = { ...rec };
        const va = rec[rowIndex];
        const vb = rec[swapRowIndex];
        if (va !== undefined) next[swapRowIndex] = va;
        else delete next[swapRowIndex];
        if (vb !== undefined) next[rowIndex] = vb;
        else delete next[rowIndex];
        return next;
      };

      const inverse: EditorCommand = {
        type: 'MOVE_VARIANT_ROW',
        rowIndex: swapRowIndex,
        direction: direction === 'up' ? 'down' : 'up',
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: swapEntry(state.rowImages),
          rowOverlays: swapEntry(state.rowOverlays),
          rowVideoClips: swapEntry(state.rowVideoClips),
          selection: swapRowIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'SET_ROW_VISUAL_TYPE': {
      const { rowIndex, visualType, promoteFields } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const row = state.doc.rows[rowIndex];
      if (row.visual_type === visualType && !promoteFields) {
        return { next: state, inverse: null };
      }
      const priorFields: Partial<ProductionDoc['rows'][number]> = {
        visual_type: row.visual_type,
      };
      const patch: Partial<ProductionDoc['rows'][number]> = { visual_type: visualType };

      if (promoteFields && visualType === 'Title Card') {
        // Mirrors the production-doc "Make this a title card" handler.
        // Capture every field we're about to overwrite so undo restores
        // the prior prompt + description + on-screen text verbatim.
        priorFields.ai_image_prompt = row.ai_image_prompt;
        priorFields.visual_description = row.visual_description;
        priorFields.stock_search_terms = row.stock_search_terms;
        priorFields.on_screen_text = row.on_screen_text;
        priorFields.notes = row.notes;

        const titleText = (row.script_text ?? '').trim();
        const priorPrompt = (row.ai_image_prompt ?? '').trim();
        const backup = priorPrompt
          ? `\n[backup-from-promote] ai_image_prompt was: ${priorPrompt}`
          : '';

        patch.ai_image_prompt = '';
        patch.stock_search_terms = '';
        patch.on_screen_text = titleText;
        patch.visual_description = titleText
          ? `Title card displaying "${titleText}"`
          : 'Title card scene';
        patch.notes = (
          `${(row.notes ?? '').trim()}${backup ? `\n${backup}`.trimStart() : ''}`
            .trim()
        ) || 'Title card scene — rendered as crisp typography without an image.';
      }

      const nextRow: ProductionDoc['rows'][number] = {
        ...row,
        ...patch,
        // Use 'structure' here — a visual_type change rewires which
        // pipeline branch the renderer takes, which is structural
        // intent. Promotion to Title Card additionally rewrites text
        // fields but the structural flip is the dominant signal.
        edited_at: stampEditedAt(row.edited_at, 'structure'),
      };
      const nextRows = state.doc.rows.slice();
      nextRows[rowIndex] = nextRow;

      const inverse: EditorCommand = {
        type: 'PATCH_ROW',
        rowIndex,
        patch: priorFields,
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

    case 'SPLIT_AS_TITLE_CARD': {
      const { rowIndex, heading } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const trimmedHeading = heading.trim();
      if (!trimmedHeading) {
        console.warn('[editor store] split-as-title-card refused — empty heading');
        return { next: state, inverse: null };
      }
      const sourceRow = state.doc.rows[rowIndex];
      const originalScriptText = sourceRow.script_text ?? '';

      // Heading match is tolerant: optional leading `##`, optional
      // whitespace, optional trailing punctuation. Mirrors the
      // production-doc page's strip regex so split behaves identically
      // across surfaces.
      const escapedHeading = trimmedHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripRe = new RegExp(
        `^\\s*(?:##\\s*)?${escapedHeading}\\s*[\\.,:;—-]?\\s*`,
        'i',
      );
      const strippedScript = originalScriptText.replace(stripRe, '').trim();
      if (strippedScript === originalScriptText.trim()) {
        console.warn('[editor store] split-as-title-card no-op — heading not found in script', {
          rowIndex,
          heading: trimmedHeading,
        });
        return { next: state, inverse: null };
      }

      const titleCardRow: ProductionDoc['rows'][number] = {
        timecode: sourceRow.timecode ?? '',
        script_text: '',
        visual_type: 'Title Card',
        visual_description: `Title card displaying "${trimmedHeading}"`,
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: trimmedHeading,
        notes: 'Auto-split title card. Lock-as-still so the title text is preserved.',
        edited_at: stampEditedAt(undefined, 'structure'),
      };

      const updatedSource: ProductionDoc['rows'][number] = {
        ...sourceRow,
        script_text: strippedScript,
        edited_at: stampEditedAt(sourceRow.edited_at, 'script_text'),
      };

      // Insert title-card ABOVE the source row. The source row's
      // assets ride along to its new index via the +1 reindex below.
      const nextRows = [
        ...state.doc.rows.slice(0, rowIndex),
        titleCardRow,
        updatedSource,
        ...state.doc.rows.slice(rowIndex + 1),
      ];
      const nextImages = reindexRowImages(state.rowImages, rowIndex, 1);
      const nextOverlays = reindexRecord(state.rowOverlays, rowIndex, 1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, rowIndex, 1);

      const inverse: EditorCommand = {
        type: 'REVERT_SPLIT_AS_TITLE_CARD',
        atIndex: rowIndex,
        sourceRowIndex: rowIndex + 1,
        restoreScriptText: originalScriptText,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          // Select the title card so the user lands on what they just
          // created — they typically want to tweak it next.
          selection: rowIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'REVERT_SPLIT_AS_TITLE_CARD': {
      const { atIndex, sourceRowIndex, restoreScriptText } = cmd;
      if (atIndex < 0 || atIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      if (sourceRowIndex < 0 || sourceRowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      if (state.doc.rows.length === 1) {
        console.warn('[editor store] revert-split-title-card refused — can\'t empty the doc');
        return { next: state, inverse: null };
      }

      const sourceRow = state.doc.rows[sourceRowIndex];
      // Capture the heading from the title card so the redo can find it
      // in the restored script.
      const titleCardRow = state.doc.rows[atIndex];
      const heading = (titleCardRow.on_screen_text ?? '').trim();

      const restoredSource: ProductionDoc['rows'][number] = {
        ...sourceRow,
        script_text: restoreScriptText,
      };
      const withSourceRestored = state.doc.rows.slice();
      withSourceRestored[sourceRowIndex] = restoredSource;
      const nextRows = [
        ...withSourceRestored.slice(0, atIndex),
        ...withSourceRestored.slice(atIndex + 1),
      ];
      const nextImages = reindexRowImages(state.rowImages, atIndex, -1);
      const nextOverlays = reindexRecord(state.rowOverlays, atIndex, -1);
      const nextVideoClips = reindexRecord(state.rowVideoClips, atIndex, -1);

      // After the splice, the original source row sits at atIndex.
      const inverse: EditorCommand = {
        type: 'SPLIT_AS_TITLE_CARD',
        rowIndex: atIndex,
        heading,
      };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          rowImages: nextImages,
          rowOverlays: nextOverlays,
          rowVideoClips: nextVideoClips,
          selection: atIndex,
          isDirty: true,
        },
        inverse,
      };
    }

    case 'APPLY_TITLE_CARD_AS_SECTION_TITLE': {
      const { rowIndex } = cmd;
      if (rowIndex < 0 || rowIndex >= state.doc.rows.length) {
        return { next: state, inverse: null };
      }
      const sourceRow = state.doc.rows[rowIndex];
      if (sourceRow.visual_type !== 'Title Card') {
        console.warn('[editor store] apply-title-as-section refused — not a Title Card row', {
          rowIndex,
          visual_type: sourceRow.visual_type,
        });
        return { next: state, inverse: null };
      }
      const text = ((sourceRow.on_screen_text ?? '').trim()
        || (sourceRow.script_text ?? '').trim()).trim();
      if (!text) {
        console.warn('[editor store] apply-title-as-section refused — no text on title card', {
          rowIndex,
        });
        return { next: state, inverse: null };
      }

      // Section runs from rowIndex+1 to the row BEFORE the next Title
      // Card (or doc end). Walking the array once gives both bounds.
      let endIndex = state.doc.rows.length - 1;
      for (let i = rowIndex + 1; i < state.doc.rows.length; i++) {
        if (state.doc.rows[i]?.visual_type === 'Title Card') {
          endIndex = i - 1;
          break;
        }
      }
      if (endIndex < rowIndex + 1) {
        // No following rows under this title card — refuse rather than
        // dirty state for a zero-op.
        return { next: state, inverse: null };
      }

      const restore: Array<{ rowIndex: number; priorSectionTitle: string | undefined }> = [];
      const nextRows = state.doc.rows.map((r, i) => {
        if (i > rowIndex && i <= endIndex) {
          restore.push({ rowIndex: i, priorSectionTitle: r.section_title });
          return { ...r, section_title: text };
        }
        return r;
      });

      const inverse: EditorCommand = {
        type: 'REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE',
        restore,
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

    case 'REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE': {
      const { restore } = cmd;
      if (restore.length === 0) {
        return { next: state, inverse: null };
      }
      const restoreMap = new Map(restore.map((e) => [e.rowIndex, e.priorSectionTitle]));
      const nextRows = state.doc.rows.map((r, i) => {
        if (!restoreMap.has(i)) return r;
        const prior = restoreMap.get(i);
        const copy = { ...r };
        if (prior === undefined) delete copy.section_title;
        else copy.section_title = prior;
        return copy;
      });

      // Redo path: dispatch APPLY_TITLE_CARD_AS_SECTION_TITLE against
      // the first row above the restore range that's a Title Card.
      // The restore range is guaranteed contiguous starting at
      // rowIndex+1 (forward command's invariant), so scanning back from
      // the first restored index lands us on the source.
      const firstAffected = Math.min(...restore.map((e) => e.rowIndex));
      let sourceIdx = firstAffected - 1;
      while (sourceIdx >= 0 && nextRows[sourceIdx]?.visual_type !== 'Title Card') {
        sourceIdx -= 1;
      }
      const inverse: EditorCommand =
        sourceIdx >= 0
          ? { type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE', rowIndex: sourceIdx }
          : // Defensive: no Title Card found above the restore range.
            // Should never happen given the forward command's guards.
            { type: 'SET_SELECTION', shotIndex: state.selection };

      return {
        next: {
          ...state,
          doc: { ...state.doc, rows: nextRows },
          isDirty: true,
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
 * Apply a pin-state directive to a row. Centralises the "forward
 * path pins, inverse path restores" semantics used by every reducer
 * command that writes `duration_override_ms`.
 *
 *   - `directive === undefined` ⇒ forward path. Set `pin_duration = true`.
 *   - `directive.value === undefined` ⇒ inverse path. Clear the field
 *     (delete the property so the row's shape matches its pre-edit
 *     form exactly — distinguishes "absent" from "explicit false").
 *   - `directive.value === boolean` ⇒ inverse path. Write that value.
 *
 * Mutates `row` IN PLACE — caller must have already cloned the row.
 * Returns nothing.
 *
 * See `_plans/2026-05-23-editor-pin-duration-architecture.md`.
 */
function applyPinDirective(
  row: ProductionDoc['rows'][number],
  directive: { value: boolean | undefined } | undefined,
): void {
  if (directive === undefined) {
    row.pin_duration = true;
    return;
  }
  if (directive.value === undefined) {
    delete (row as { pin_duration?: boolean }).pin_duration;
    return;
  }
  row.pin_duration = directive.value;
}

/**
 * Capture a row's current pin state for an inverse command. Mirrors
 * `applyPinDirective`'s shape so the round-trip is symmetric.
 */
function capturePinState(
  row: ProductionDoc['rows'][number],
): { value: boolean | undefined } {
  return { value: row.pin_duration };
}

/**
 * Split a row's motion_beats[] at `splitAtMs` (relative to the row's
 * start) for SPLIT_SHOT. Beats fully before the split stay on the first
 * half unchanged; beats fully after move to the second half with
 * `startMs` rebased to the second half's local 0. Beats that span the
 * split are dropped — splitting through an active animation is rare,
 * and a clean drop is less surprising than a half-rendered beat.
 *
 * Boundary policy:
 *   - `startMs + durationMs <= splitAtMs` → first half (a beat that
 *     ends exactly at the split has finished animating; belongs to the
 *     first half).
 *   - `startMs >= splitAtMs` → second half (a beat starting exactly at
 *     the split is a clean second-half opener at relative t=0).
 *   - Everything in between spans → dropped.
 *
 * Returns the two arrays as `undefined` when empty so the caller can
 * write the field optionally — keeps the JSON compact and matches the
 * "absent unless meaningful" shape of every other optional row field.
 *
 * See `_plans/2026-06-02-shot-split-ui.md`.
 */
function sliceMotionBeats(
  beats: MotionBeat[] | undefined,
  splitAtMs: number,
): { first: MotionBeat[] | undefined; second: MotionBeat[] | undefined; dropped: number } {
  if (!beats || beats.length === 0) {
    return { first: undefined, second: undefined, dropped: 0 };
  }
  const first: MotionBeat[] = [];
  const second: MotionBeat[] = [];
  let dropped = 0;
  for (const b of beats) {
    const beatEnd = b.startMs + b.durationMs;
    if (beatEnd <= splitAtMs) first.push(b);
    else if (b.startMs >= splitAtMs) second.push({ ...b, startMs: b.startMs - splitAtMs });
    else dropped += 1;
  }
  return {
    first: first.length > 0 ? first : undefined,
    second: second.length > 0 ? second : undefined,
    dropped,
  };
}

/** Variant-group fields that live as a unit. SPLIT_SHOT detaches the
 *  second half by clearing all of them — leaving a partial set
 *  (e.g. group_id without variant_index) would confuse the variant
 *  inspector and the editor's variant resolution. Keep this list in
 *  sync with `ProductionRow`'s variant block (around line 720 of
 *  src/remotion/utils.ts). */
const VARIANT_GROUP_FIELDS = [
  'group_id',
  'variant_index',
  'variant_edit_prompt',
  'variant_base_image_at_generation',
  'variant_derives_from_previous',
  'group_variant_chain_default',
] as const;

/** True when `row` has any variant-group field set — used to log
 *  whether a SPLIT_SHOT actually detached anything. */
function rowHasVariantFields(row: ProductionDoc['rows'][number]): boolean {
  const bag = row as unknown as Record<string, unknown>;
  for (const f of VARIANT_GROUP_FIELDS) {
    if (bag[f] !== undefined) return true;
  }
  return false;
}

/** Mutate `row` IN PLACE to clear every variant-group field. Caller
 *  must have already cloned the row. */
function detachVariantFields(row: ProductionDoc['rows'][number]): void {
  const bag = row as unknown as Record<string, unknown>;
  for (const f of VARIANT_GROUP_FIELDS) {
    delete bag[f];
  }
}

/**
 * Build a fresh blank-content row for INSERT_BLANK_SHOT. Mirrors the
 * field set DELETE_SHOT 'blank' mode produces (`visual_type: 'blank'`,
 * empty string fields) so downstream renderer code and auto-pipeline
 * gates treat newly-inserted scenes identically to blanked ones. The
 * caller picks `durationMs`; the row's `edited_at` is stamped fresh
 * so re-gen passes recognise it as user-touched and don't overwrite.
 */
function makeBlankRow(durationMs: number): ProductionDoc['rows'][number] {
  return {
    timecode: '',
    script_text: '',
    visual_type: 'blank',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    duration_override_ms: durationMs,
    // User explicitly created this scene with a chosen duration —
    // pin it so alignment doesn't silently swallow the blank slot
    // into an adjacent narrated row's word boundaries.
    // 2026-05-23 pin-duration architecture.
    pin_duration: true,
    edited_at: stampEditedAt(undefined, 'structure'),
  };
}

/**
 * Compute the row's effective duration in ms — the SAME value the
 * SET_SHOT_TIMING reducer uses when reading current state. Public
 * because EditorClient needs it to translate the popover's aligned-
 * space input into cascade-space dispatch values; without using the
 * exact same calc as the reducer the delta lands in the wrong
 * timebase and the dispatch silently no-ops / clamps.
 *
 * Override wins; otherwise falls back to `naturalRowDurationMs`
 * which derives from timecodes.
 */
export function rowEffectiveDurationMs(doc: ProductionDoc, index: number): number {
  const row = doc.rows[index];
  if (!row) return 0;
  return typeof row.duration_override_ms === 'number'
    ? row.duration_override_ms
    : naturalRowDurationMs(doc, index);
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
 * Effective duration of `rows[index]` matching the renderer's view
 * (`computeProductionDocIntervals` in remotion/utils.ts):
 *   - duration_override_ms wins when valid.
 *   - Otherwise: next row's timecode (or doc.total_duration for the
 *     last row) minus this row's timecode, floored at EDITOR_MIN_SHOT_MS.
 *
 * This DIFFERS from `naturalRowDurationMs` for the final row only —
 * that helper returns EDITOR_MIN_SHOT_MS (2s floor) for the last row
 * because it doesn't parse total_duration. The renderer extends the
 * last row to `doc.total_duration`, so any caller that needs the
 * value the user actually SEES on the timeline (e.g. ripple-delete
 * stamping `duration_override_ms`) must use THIS helper.
 *
 * Exported for tests; internal callers below.
 */
export function rendererEffectiveDurationMs(
  doc: ProductionDoc,
  index: number,
): number {
  const row = doc.rows[index];
  if (!row) return 0;
  if (typeof row.duration_override_ms === 'number'
      && Number.isFinite(row.duration_override_ms)
      && row.duration_override_ms > 0) {
    return row.duration_override_ms;
  }
  const startMs = parseTimecodeMs(row.timecode);
  if (startMs === null) return EDITOR_MIN_SHOT_MS;
  const nextRow = doc.rows[index + 1];
  if (nextRow) {
    const nextMs = parseTimecodeMs(nextRow.timecode);
    if (nextMs !== null && nextMs > startMs) return nextMs - startMs;
    return EDITOR_MIN_SHOT_MS;
  }
  // Last row — uses doc.total_duration, mirroring the renderer.
  const totalRaw = doc.total_duration ?? '';
  const totalMs = parseTimecodeMs(totalRaw);
  if (totalMs !== null && totalMs > startMs) return totalMs - startMs;
  return EDITOR_MIN_SHOT_MS;
}

/** Format milliseconds as "M:SS" (whole seconds, no leading zero on
 *  the minute). Matches the shape `parseTimecodeMs` accepts so a
 *  round-trip is stable to one-second precision. */
function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Shift a timecode string LEFT by `shiftMs`. Preserves the range
 *  format ("0:30-0:33") when present by shifting both halves; falls
 *  back to a single "M:SS" when the input is a bare timecode. Returns
 *  the input unchanged when it can't be parsed (empty string,
 *  non-numeric content) so caller doesn't have to special-case it. */
function shiftTimecodeMs(timecode: string, shiftMs: number): string {
  if (!timecode) return timecode;
  // Range pattern: leading M:SS + separator (hyphen / en-dash / em-dash)
  // + trailing M:SS. We split on the first separator so timecodes like
  // "0:30 - 0:33" with surrounding whitespace still work.
  const rangeMatch = timecode.match(/^\s*(\d{1,2}:\d{1,2})\s*([–\-—])\s*(\d{1,2}:\d{1,2})\s*$/);
  if (rangeMatch) {
    const [, startStr, sep, endStr] = rangeMatch;
    const startMs = parseTimecodeMs(startStr);
    const endMs = parseTimecodeMs(endStr);
    if (startMs === null || endMs === null) return timecode;
    const newStart = Math.max(0, startMs - shiftMs);
    const newEnd = Math.max(newStart, endMs - shiftMs);
    return `${formatMmSs(newStart)}${sep}${formatMmSs(newEnd)}`;
  }
  const baseMs = parseTimecodeMs(timecode);
  if (baseMs === null) return timecode;
  return formatMmSs(Math.max(0, baseMs - shiftMs));
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
  captions?: CaptionsBundle;
  rowOverlays?: Record<number, RowOverlayRenderState>;
  rowVideoClips?: Record<number, RowVideoClipState>;
  musicUrl?: string;
  brandKitOverride?: Partial<BrandKit>;
  channelId?: string;
  voiceoverAlignment?: ForcedAlignmentResponse;
  flags?: ProjectPayloadFlags;
  linkedProjectId?: string;
  linkedScheduleItemId?: string;
  visualKitOverride?: ChannelVisualBrandKit;
  version: number;
}): EditorState {
  return {
    doc: args.doc,
    rowImages: args.rowImages,
    voiceoverUrl: args.voiceoverUrl,
    captions: args.captions,
    rowOverlays: args.rowOverlays ?? {},
    rowVideoClips: args.rowVideoClips ?? {},
    musicUrl: args.musicUrl,
    brandKitOverride: args.brandKitOverride,
    channelId: args.channelId,
    voiceoverAlignment: args.voiceoverAlignment,
    flags: args.flags ?? {
      animateScenes: true,
      suppressLowerThirds: false,
      overlaysDisabled: false,
      rowLockedAsStill: {},
    },
    linkedProjectId: args.linkedProjectId,
    linkedScheduleItemId: args.linkedScheduleItemId,
    visualKitOverride: args.visualKitOverride,
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
  captions?: CaptionsBundle;
  rowOverlays?: Record<number, RowOverlayRenderState>;
  rowVideoClips?: Record<number, RowVideoClipState>;
  musicUrl?: string;
  brandKitOverride?: Partial<BrandKit>;
  channelId?: string;
  voiceoverAlignment?: ForcedAlignmentResponse;
  flags: ProjectPayloadFlags;
  linkedProjectId?: string;
  linkedScheduleItemId?: string;
  visualKitOverride?: ChannelVisualBrandKit;
} {
  return {
    doc: state.doc,
    rowImages: state.rowImages,
    voiceoverUrl: state.voiceoverUrl,
    captions: state.captions,
    linkedProjectId: state.linkedProjectId,
    linkedScheduleItemId: state.linkedScheduleItemId,
    visualKitOverride: state.visualKitOverride,
    // Persist rowOverlays back so the production-doc page picks up any
    // overlay edits the user makes inside the editor next time they
    // open the doc there. Omit when empty to keep payloads small for
    // rows that never had an overlay.
    rowOverlays: Object.keys(state.rowOverlays).length > 0 ? state.rowOverlays : undefined,
    // Phase 3b parity refactor: every previously-pass-through field
    // round-trips so an editor save doesn't wipe production-doc's
    // contributions. The editor's toolbar mutates `flags`; the rest
    // (rowVideoClips, music, brand, channel, alignment) are
    // pass-through for now.
    rowVideoClips: Object.keys(state.rowVideoClips).length > 0 ? state.rowVideoClips : undefined,
    musicUrl: state.musicUrl,
    brandKitOverride: state.brandKitOverride,
    channelId: state.channelId,
    voiceoverAlignment: state.voiceoverAlignment,
    flags: state.flags,
  };
}
