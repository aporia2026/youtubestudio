'use client';

/**
 * CapCut-style timeline editor.
 *
 * M1: read-only mount. Renders the doc's rows as clips on a single
 * "video" track via `@xzdarcy/react-timeline-editor`. Drag/trim/
 * split/cut/reorder land in M2–M5; audio support in M6.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md.
 */

import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
// The library ships its own CSS (clip rectangles, playhead, ruler,
// scrollbar) but doesn't auto-inject. Without this import the
// timeline area renders empty even though the data is there.
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import {
  computeRowIntervals,
  docToTimelineRows,
  targetIndexFromDropMs,
  totalDocDurationMs,
  type TimelineActionData,
} from './timeline-data-adapter';
import {
  cutRow,
  cutVoiceoverSegment,
  moveRow,
  moveVoiceoverSegment,
  setRowTransitionIn,
  splitRowAtPlayheadMs,
  splitVoiceoverSegmentAtPlayheadMs,
  trimRowDuration,
  trimVoiceoverSegmentDuration,
} from './timeline-mutations';
import { msToSec, secToMs, DEFAULT_FPS } from '@/lib/timeline-editor/frame-math';
import { slicePeaks } from '@/lib/timeline-editor/audio-peaks';
import { useAudioPeaks } from '@/lib/timeline-editor/use-audio-peaks';

/** Local shape for the library's `effects` prop. The library imports
 *  `TimelineEffect` from `@xzdarcy/timeline-engine` (a transitive dep)
 *  but doesn't re-export it, so we duplicate the minimal shape here. */
interface LibTimelineEffect {
  id: string;
  name: string;
}

const TIMELINE_EFFECTS: Record<string, LibTimelineEffect> = {
  video: { id: 'video', name: 'Video' },
  voiceover: { id: 'voiceover', name: 'Voiceover' },
};

export interface TimelineEditorProps {
  doc: ProductionDoc;
  /** Called after any edit. `commit:false` means "live-preview
   *  this value but don't push to the undo stack" — fired on
   *  every onActionResizing tick during a drag. `commit:true`
   *  (default) means "push to undo stack" — fired on every
   *  discrete op (split, cut, fade, reorder, drag-resize end).
   *  M1 keeps this optional so the editor can be mounted read-only. */
  onDocChange?: (doc: ProductionDoc, opts?: { commit?: boolean }) => void;
  /** Hooks to wire the undo/redo stack the parent owns. Surfaced
   *  on the toolbar + bound to Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Called at the start of a multi-step batched edit (drag-resize,
   *  future drag-move-live). The history layer should snapshot the
   *  current head so a single Cmd+Z after the drag restores the
   *  pre-drag state. Without this, every live tick of the drag
   *  overwrites the head and the original is lost. */
  onBeginBatch?: () => void;
  /** ms per pixel at the default zoom. Default = 10 (so 1 second
   *  occupies 100 px on screen, matching CapCut's default zoom).
   *  A 30-second doc fits in ~3000 px which scrolls horizontally
   *  inside the container; we don't try to fit-to-width because
   *  CapCut feel comes from a consistent zoom not a compressed view. */
  msPerPx?: number;
  /** Frames per second for snap. Defaults to the renderer's fps. */
  fps?: number;
  /** External playhead position, in seconds. Set this from the
   *  sibling video preview's frameupdate event so the timeline's blue
   *  playhead mirrors the Player as it plays. When undefined the
   *  timeline runs in standalone mode (the user can still drag the
   *  playhead with no consumer). */
  playheadSecExternal?: number;
  /** Called when the user actively moves the playhead — either by
   *  dragging the blue line or by clicking a clip (which jumps the
   *  playhead to the clip's start). The host wires this to a Player
   *  seekTo so the preview follows. Programmatic playhead updates
   *  driven by `playheadSecExternal` do NOT fire this callback —
   *  they're echo-suppressed to avoid a feedback loop. */
  onPlayheadSeek?: (sec: number) => void;
}

/** Allowed msPerPx zoom stops. CapCut-style discrete zoom levels
 *  let users hit familiar densities (50 px/sec, 100 px/sec, etc.)
 *  rather than slowly scrubbing a slider. Smaller index = closer
 *  zoom (more pixels per second). */
const ZOOM_LEVELS_MS_PER_PX = [2, 5, 10, 20, 50, 100, 200];
const DEFAULT_ZOOM_INDEX = 2; // 10 ms/px = 100 px/sec, matches CapCut default.

export function TimelineEditor({
  doc,
  onDocChange,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onBeginBatch,
  msPerPx,
  fps = DEFAULT_FPS,
  playheadSecExternal,
  onPlayheadSeek,
}: TimelineEditorProps) {
  // Zoom is internal state, seeded from the optional `msPerPx`
  // prop. If the caller pins it, we honour that prop and disable
  // the in/out buttons (rare; mostly for tests).
  const initialZoomIndex = useMemo(() => {
    if (msPerPx === undefined) return DEFAULT_ZOOM_INDEX;
    // Snap any prop value to the closest level so the buttons stay
    // consistent.
    let best = 0;
    let bestDelta = Math.abs(ZOOM_LEVELS_MS_PER_PX[0] - msPerPx);
    for (let i = 1; i < ZOOM_LEVELS_MS_PER_PX.length; i++) {
      const d = Math.abs(ZOOM_LEVELS_MS_PER_PX[i] - msPerPx);
      if (d < bestDelta) {
        best = i;
        bestDelta = d;
      }
    }
    return best;
  }, [msPerPx]);
  const [zoomIndex, setZoomIndex] = useState(initialZoomIndex);
  const effectiveMsPerPx = ZOOM_LEVELS_MS_PER_PX[zoomIndex];
  const zoomIn = useCallback(() => setZoomIndex((i) => Math.max(0, i - 1)), []);
  const zoomOut = useCallback(() => setZoomIndex((i) => Math.min(ZOOM_LEVELS_MS_PER_PX.length - 1, i + 1)), []);
  const canZoomIn = zoomIndex > 0;
  const canZoomOut = zoomIndex < ZOOM_LEVELS_MS_PER_PX.length - 1;
  const rows = useMemo(() => docToTimelineRows(doc), [doc]);
  const totalSec = useMemo(() => msToSec(totalDocDurationMs(doc)), [doc]);

  // Refs / state for M3 keybindings:
  //   timelineRef  — library hook for playhead time + listener.
  //   selectedRow  — last-clicked row index, target for Del key.
  //   playheadSec  — kept in sync via the library's tick listener.
  //   containerRef — keydown listener owner so the editor only
  //                  consumes keystrokes when it has focus / hover.
  const timelineRef = useRef<TimelineState>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Selection is track-aware so Del / F / split / drag operate on
  // the right entity. Video-row selection still drives the "selected
  // clip #N" header indicator; voiceover selection drives audio-row
  // operations.
  type Selection =
    | { track: 'video'; rowIndex: number }
    | { track: 'voiceover'; segmentIndex: number };
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);

  // The library exposes the per-frame action coordinates as
  // (start, end) in seconds, both ABSOLUTE on the timeline. For a
  // single-track cumulative model (this row's start == prior rows'
  // total duration), the row's new duration is just (end - start)
  // regardless of which edge the user dragged.
  //
  // Hold a ref to the latest doc so the resize handler closure (the
  // library captures it once) can mutate against the freshest state
  // when the user drags multiple times in a row.
  const docRef = useRef(doc);
  docRef.current = doc;

  // M5 polish: snapshot the pre-drag state at resize start so a
  // single Cmd+Z after the drag restores it. Without this, every
  // live tick during the drag overwrites the head and the pre-drag
  // state is lost.
  const handleResizeStart = useCallback(() => {
    if (!onDocChange || !onBeginBatch) return;
    onBeginBatch();
  }, [onDocChange, onBeginBatch]);

  const handleResizing = useCallback(
    (args: { action: { id: string; data?: TimelineActionData['data'] }; start: number; end: number; dir: 'left' | 'right' }) => {
      if (!onDocChange) return false; // read-only
      const data = args.action.data;
      if (!data) return false;
      const newDurationMs = secToMs(args.end - args.start);
      const next = data.kind === 'video'
        ? trimRowDuration(docRef.current, data.rowIndex, newDurationMs, { fps })
        : trimVoiceoverSegmentDuration(docRef.current, data.segmentIndex, newDurationMs, { fps });
      if (next !== docRef.current) {
        // Live preview during the drag — does NOT push to the undo
        // stack (the pre-drag snapshot was pushed by handleResizeStart
        // → onBeginBatch). Live updates mutate the new head in place.
        onDocChange(next, { commit: false });
      }
      // Return value is consumed by the library to allow/block the
      // visual move. Returning `undefined` (default) keeps it allowed.
      return undefined;
    },
    [onDocChange, fps],
  );

  const handleResizeEnd = useCallback(
    (args: { action: { id: string; data?: TimelineActionData['data'] }; start: number; end: number; dir: 'left' | 'right' }) => {
      // Final snap on release — onActionResizing already snaps every
      // tick, but the library reports the unrounded values on
      // ResizeEnd. Re-running here is a no-op when the value matches
      // but cheap insurance against drift.
      if (!onDocChange) return;
      const data = args.action.data;
      if (!data) return;
      const newDurationMs = secToMs(args.end - args.start);
      const next = data.kind === 'video'
        ? trimRowDuration(docRef.current, data.rowIndex, newDurationMs, { fps })
        : trimVoiceoverSegmentDuration(docRef.current, data.segmentIndex, newDurationMs, { fps });
      // Commit the final value to undo. Even on a no-op we want to
      // promote the live-head into a committed entry so a Cmd+Z
      // takes you back to where you started the drag.
      onDocChange(next, { commit: true });
    },
    [onDocChange, fps],
  );

  const editable = onDocChange !== undefined;

  // Echo guard for the Player → Timeline → Player feedback loop.
  // When the host echoes the Player's frame into `playheadSecExternal`,
  // we call tl.setTime() which synchronously fires `afterSetTime`.
  // Without this guard, the listener would then call `onPlayheadSeek`,
  // the host would seek the Player, the Player would emit another
  // frameupdate, and we'd loop. The ref is flipped on right around
  // the programmatic setTime call and consumed on the next listener
  // tick.
  const suppressEchoRef = useRef(false);

  // M3 + sync: subscribe to the library's tick + cursor-drag events.
  //  - setTimeByTick: fires during the library's own playback (we
  //    don't use it but keeping the playhead state aligned costs
  //    nothing). Not treated as a user seek.
  //  - afterSetTime: fires both when the user drags the playhead AND
  //    when we programmatically setTime(). The suppressEchoRef
  //    distinguishes the two; only user-initiated time changes
  //    surface to the host as a seek.
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const onTick = ({ time }: { time: number }) => setPlayheadSec(time);
    const onAfterSet = ({ time }: { time: number }) => {
      setPlayheadSec(time);
      if (suppressEchoRef.current) {
        suppressEchoRef.current = false;
        return;
      }
      onPlayheadSeek?.(time);
    };
    tl.listener.on('setTimeByTick', onTick);
    tl.listener.on('afterSetTime', onAfterSet);
    return () => {
      tl.listener.offAll();
    };
  }, [onPlayheadSeek]);

  // Mirror the external playhead (driven by the Player's frameupdate
  // in the host) into the library. Guarded by an identity check so
  // a repeated same-frame update doesn't churn the lib. The echo
  // suppression ref protects against the loop described above.
  useEffect(() => {
    if (playheadSecExternal === undefined || playheadSecExternal === null) return;
    const tl = timelineRef.current;
    if (!tl) return;
    // 1 ms tolerance so frame-snapped seconds (e.g. 0.0333... at 30 fps)
    // don't bounce against each other.
    if (Math.abs(tl.getTime() - playheadSecExternal) < 0.001) return;
    suppressEchoRef.current = true;
    tl.setTime(playheadSecExternal);
  }, [playheadSecExternal]);

  // M3: S splits the row under the playhead; Del deletes the
  // currently selected row. Keydown is listened on the container
  // so it only fires when the timeline area has focus, not while
  // the user is typing in the global app.
  useEffect(() => {
    if (!editable || !onDocChange) return;
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      // Skip when the focus is inside an editable field — we don't
      // want `S` in a text input to split the timeline.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      // Undo/redo come first so Cmd+S below doesn't double-fire
      // for the same keystroke when a user holds Shift+Cmd+Z.
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          onRedo?.();
        } else {
          onUndo?.();
        }
        return;
      }
      // Cmd/Ctrl+Y is the alternate redo binding many editors honour.
      if (isMeta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        onRedo?.();
        return;
      }
      // Zoom: Ctrl/Cmd + '=' (or '+') zooms in; '-' zooms out.
      // '0' resets to the default level. Matches CapCut + most
      // editors. The key is '=' on unshifted keyboards because
      // browsers report e.key='+' only when Shift is held.
      if (isMeta && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (isMeta && e.key === '-') {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (isMeta && e.key === '0') {
        e.preventDefault();
        setZoomIndex(DEFAULT_ZOOM_INDEX);
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        if (isMeta) return; // let Cmd+S fall through to the browser
        // S splits BOTH tracks at the playhead. If the playhead is
        // inside a video clip AND inside a voiceover segment, both
        // get split; if only one applies, only that one mutates.
        // (UX note: this diverges from CapCut, which splits only
        // the selected track. Single-shortcut multi-track split
        // is the v1 default to keep audio + video in sync after
        // any cut; a future polish could read `selection?.track`
        // and split only that one.)
        const playheadMs = secToMs(playheadSec);
        const prevDoc = docRef.current;
        let next = splitRowAtPlayheadMs(prevDoc, playheadMs, { fps });
        const videoSplit = next !== prevDoc;
        const videoSplitIndex = videoSplit
          ? prevDoc.rows.findIndex((_, i) => {
              // The first row that has DIFFERENT identity in `next`
              // is the one that was split.
              return next.rows[i] !== prevDoc.rows[i];
            })
          : -1;
        const beforeVoiceSplit = next;
        next = splitVoiceoverSegmentAtPlayheadMs(next, playheadMs, { fps });
        const voiceSplit = next !== beforeVoiceSplit;
        const voiceSplitIndex = voiceSplit && beforeVoiceSplit.voiceover_segments
          ? beforeVoiceSplit.voiceover_segments.findIndex((_, i) => {
              return (next.voiceover_segments?.[i] ?? null) !== beforeVoiceSplit.voiceover_segments?.[i];
            })
          : -1;
        if (next !== prevDoc) {
          e.preventDefault();
          onDocChange(next, { commit: true });
          // Shift the selection index forward by one when the split
          // happened AT OR BEFORE the selected row in the same track.
          // Without this, a user who had row 5 selected and split
          // row 2 would suddenly find row 4 (the new "old row 5")
          // selected — silently wrong.
          if (selection?.track === 'video' && videoSplit && videoSplitIndex >= 0 && selection.rowIndex >= videoSplitIndex + 1) {
            setSelection({ track: 'video', rowIndex: selection.rowIndex + 1 });
          } else if (selection?.track === 'voiceover' && voiceSplit && voiceSplitIndex >= 0 && selection.segmentIndex >= voiceSplitIndex + 1) {
            setSelection({ track: 'voiceover', segmentIndex: selection.segmentIndex + 1 });
          }
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection === null) return;
        const next = selection.track === 'video'
          ? cutRow(docRef.current, selection.rowIndex)
          : cutVoiceoverSegment(docRef.current, selection.segmentIndex);
        if (next !== docRef.current) {
          e.preventDefault();
          onDocChange(next, { commit: true });
          setSelection(null);
        }
      } else if (e.key === 'f' || e.key === 'F') {
        // F toggles cross-fade on the SELECTED video row's incoming
        // transition. No-op when the selection is on the voiceover
        // track (audio cross-fades aren't modeled in v1).
        if (selection === null || selection.track !== 'video') return;
        const current = docRef.current.rows[selection.rowIndex]?.transition_in ?? null;
        const nextTransition: 'cross-fade' | null = current === 'cross-fade' ? null : 'cross-fade';
        const next = setRowTransitionIn(docRef.current, selection.rowIndex, nextTransition);
        if (next !== docRef.current) {
          e.preventDefault();
          onDocChange(next, { commit: true });
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [editable, onDocChange, onUndo, onRedo, fps, playheadSec, selection, zoomIn, zoomOut]);

  // Click on a clip selects it AND jumps the preview to the clip's
  // start. CapCut UX: clicking a clip in the timeline immediately
  // updates the player to that point — there's no "select then
  // separately seek" gesture. The seek travels via `onPlayheadSeek`
  // → host → Player.seekTo, and the host echoes the new frame back
  // through `playheadSecExternal` so the timeline's blue line
  // catches up. Track-aware so clicking a voiceover segment doesn't
  // make Del delete a video row, and vice versa.
  const handleClickAction = useCallback(
    (_e: React.MouseEvent, args: { action: { id: string; data?: TimelineActionData['data'] } }) => {
      const data = args.action.data;
      if (!data) {
        setSelection(null);
        return;
      }
      if (data.kind === 'video') {
        setSelection({ track: 'video', rowIndex: data.rowIndex });
        const intervals = computeRowIntervals(docRef.current);
        const interval = intervals[data.rowIndex];
        if (interval && onPlayheadSeek) {
          onPlayheadSeek(interval.startMs / 1000);
        }
      } else {
        setSelection({ track: 'voiceover', segmentIndex: data.segmentIndex });
        // Voiceover clicks also seek so audio + video stay in sync.
        const segments = docRef.current.voiceover_segments ?? [];
        let startMs = 0;
        for (let i = 0; i < data.segmentIndex; i++) startMs += segments[i]?.durationMs ?? 0;
        if (onPlayheadSeek) onPlayheadSeek(startMs / 1000);
      }
    },
    [onPlayheadSeek],
  );

  // M4: drag-reorder. During the drag we let the library render
  // the clip wherever the user moves it (return undefined from
  // onActionMoving). On drop we compute the target row index from
  // the dropped position via targetIndexFromDropMs and call moveRow.
  // Single-track in v1, so we ignore the `row` arg.
  const handleMoveEnd = useCallback(
    (args: { action: { id: string; data?: TimelineActionData['data'] }; start: number }) => {
      if (!onDocChange) return;
      const data = args.action.data;
      if (!data) return;
      const dropMs = secToMs(args.start);
      if (data.kind === 'video') {
        const fromIndex = data.rowIndex;
        const toIndex = targetIndexFromDropMs(docRef.current, fromIndex, dropMs);
        if (toIndex === fromIndex) return;
        const next = moveRow(docRef.current, fromIndex, toIndex);
        if (next !== docRef.current) {
          onDocChange(next, { commit: true });
          setSelection({ track: 'video', rowIndex: toIndex });
        }
      } else {
        // Voiceover reorder. targetIndexFromDropMs is video-specific;
        // for v1 we just snap to "nearest segment slot" via a parallel
        // walk over the voiceover_segments durations.
        const fromIndex = data.segmentIndex;
        const segs = docRef.current.voiceover_segments ?? [];
        const withoutDragged = segs.filter((_, i) => i !== fromIndex);
        const gapStarts: number[] = [0];
        let cursor = 0;
        for (const s of withoutDragged) {
          cursor += s.durationMs;
          gapStarts.push(cursor);
        }
        let bestGap = 0;
        let bestDist = Math.abs(dropMs - gapStarts[0]);
        for (let i = 1; i < gapStarts.length; i++) {
          const d = Math.abs(dropMs - gapStarts[i]);
          if (d < bestDist) { bestGap = i; bestDist = d; }
        }
        if (bestGap === fromIndex) return;
        const next = moveVoiceoverSegment(docRef.current, fromIndex, bestGap);
        if (next !== docRef.current) {
          onDocChange(next, { commit: true });
          setSelection({ track: 'voiceover', segmentIndex: bestGap });
        }
      }
    },
    [onDocChange],
  );

  const handleFadeClick = useCallback(() => {
    if (!onDocChange || selection === null || selection.track !== 'video') return;
    const current = docRef.current.rows[selection.rowIndex]?.transition_in ?? null;
    const nextTransition: 'cross-fade' | null = current === 'cross-fade' ? null : 'cross-fade';
    const next = setRowTransitionIn(docRef.current, selection.rowIndex, nextTransition);
    if (next !== docRef.current) onDocChange(next, { commit: true });
  }, [onDocChange, selection]);

  // Header buttons for users without keyboards (or who want explicit
  // affordances). Wraps the same mutation helpers the keymap calls.
  const handleSplitClick = useCallback(() => {
    if (!onDocChange) return;
    // Split both tracks. Either or both can no-op depending on which
    // tracks the playhead is currently inside.
    let next = splitRowAtPlayheadMs(docRef.current, secToMs(playheadSec), { fps });
    next = splitVoiceoverSegmentAtPlayheadMs(next, secToMs(playheadSec), { fps });
    if (next !== docRef.current) onDocChange(next, { commit: true });
  }, [onDocChange, fps, playheadSec]);

  const handleCutClick = useCallback(() => {
    if (!onDocChange || selection === null) return;
    const next = selection.track === 'video'
      ? cutRow(docRef.current, selection.rowIndex)
      : cutVoiceoverSegment(docRef.current, selection.segmentIndex);
    if (next !== docRef.current) {
      onDocChange(next, { commit: true });
      setSelection(null);
    }
  }, [onDocChange, selection]);

  // Pixel math: `scale` = seconds per major tick, `scaleWidth` = px
  // per major tick. Together they define ms-per-px.
  //   secondsPerTick × pxPerTick = pxPerSecond → 1000 / pxPerSecond = msPerPx
  // We hold scale at 1 second and derive scaleWidth from msPerPx.
  const scale = 1;
  const scaleWidth = 1000 / effectiveMsPerPx; // px per second

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/40 p-4 text-sm outline-none focus:border-neutral-600"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-neutral-100">Timeline</h3>
          <p className="text-xs text-neutral-400">
            {doc.rows.length} clips · {totalSec.toFixed(1)}s · {fps} fps · playhead {playheadSec.toFixed(2)}s
            {selection?.track === 'video' && <> · selected clip #{selection.rowIndex + 1}</>}
            {selection?.track === 'voiceover' && <> · selected audio segment #{selection.segmentIndex + 1}</>}
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={zoomOut}
                disabled={!canZoomOut}
                title="Zoom out (Ctrl/Cmd + −)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                −
              </button>
              <span className="font-mono text-[10px] text-neutral-500" title="pixels per second">
                {(1000 / effectiveMsPerPx).toFixed(0)} px/s
              </span>
              <button
                type="button"
                onClick={zoomIn}
                disabled={!canZoomIn}
                title="Zoom in (Ctrl/Cmd + +)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
            <span className="text-neutral-700">·</span>
            {onUndo && (
              <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                title="Undo (Ctrl/Cmd+Z)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↶ Undo
              </button>
            )}
            {onRedo && (
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                title="Redo (Ctrl/Cmd+Shift+Z)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↷ Redo
              </button>
            )}
            <span className="text-neutral-700">·</span>
            <button
              type="button"
              onClick={handleSplitClick}
              title="Split at playhead (S)"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-neutral-500"
            >
              ✂ Split · S
            </button>
            <button
              type="button"
              onClick={handleCutClick}
              disabled={selection === null}
              title="Delete selected clip (Del)"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ✕ Cut · Del
            </button>
            <button
              type="button"
              onClick={handleFadeClick}
              disabled={selection?.track !== 'video'}
              title="Toggle cross-fade on selected clip (F)"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-sky-700 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ⤬ Fade · F
            </button>
          </div>
        )}
      </header>

      <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950">
        <Timeline
          ref={timelineRef}
          editorData={rows}
          effects={TIMELINE_EFFECTS}
          onChange={() => { /* M2 wires this. M1 is read-only. */ }}
          onClickAction={handleClickAction}
          scale={scale}
          scaleWidth={scaleWidth}
          scaleSplitCount={10}
          rowHeight={48}
          startLeft={20}
          minScaleCount={Math.max(20, Math.ceil(totalSec + 5))}
          dragLine
          gridSnap
          autoScroll
          // Library default is 600px tall, which over-extends our
          // container. 240 fits one video track + the 32px ruler
          // + an audio track in M6 with room left for a hover
          // tooltip. width:auto lets the library compute its own.
          style={{ height: 240, width: '100%' }}
          getActionRender={(action) => {
            const data = (action as { data?: TimelineActionData['data'] }).data;
            if (!data) {
              // QA fix 2026-06-05: returning null leaves the library's
              // outer rectangle painted with no content — silently
              // invisible clips when the adapter forgot a row. A tiny
              // placeholder + console.warn makes the failure
              // observable.
              console.warn('[timeline-editor] clip with no data:', action.id);
              return (
                <div className="flex h-full items-center justify-center bg-red-950/40 px-1 font-mono text-[9px] text-red-300">
                  ? {action.id}
                </div>
              );
            }
            const isSelected =
              (data.kind === 'video' && selection?.track === 'video' && selection.rowIndex === data.rowIndex)
              || (data.kind === 'voiceover' && selection?.track === 'voiceover' && selection.segmentIndex === data.segmentIndex);
            return <ClipCard data={data} selected={isSelected} />;
          }}
          // M2: drag-trim/drag-resize wired into trimRowDuration.
          // Library hands us (start, end) seconds; we convert to
          // ms, snap to frame, write `duration_override_ms`.
          // dir='left' and dir='right' collapse to the same op
          // because the doc model is cumulative — moving the left
          // edge or the right edge both change THIS row's duration.
          // M3 will add split (S key) + cut (Del); M4 wires reorder
          // by un-blocking onActionMoving.
          onActionResizeStart={editable ? handleResizeStart : undefined}
          onActionResizing={editable ? handleResizing : () => false}
          onActionResizeEnd={editable ? handleResizeEnd : undefined}
          // M4: allow horizontal drag (no return), snap on drop via
          // handleMoveEnd → targetIndexFromDropMs → moveRow. Single-
          // track in v1 so cross-track drag is moot; on drop the row
          // resnap to its slot in the cumulative cascade.
          onActionMoving={editable ? undefined : () => false}
          onActionMoveEnd={editable ? handleMoveEnd : undefined}
          // The library wants `onChange` for its internal book-
          // keeping (selection, drag-line). We just no-op here
          // because every doc mutation goes through onDocChange.
          // M4 will hook this up for drag-reorder.
        />
      </div>
    </div>
  );
}

function ClipCard({ data, selected }: { data: TimelineActionData['data']; selected: boolean }) {
  if (data.kind === 'voiceover') return <VoiceoverClipCard data={data} selected={selected} />;
  const baseColour =
    data.visualType === 'stock'
      ? 'bg-amber-950/60'
      : data.visualType === 'overlay'
      ? 'bg-emerald-950/60'
      : 'bg-violet-950/60';
  const borderColour = selected
    ? 'border-neutral-200 ring-1 ring-neutral-200/50'
    : data.visualType === 'stock'
    ? 'border-amber-700'
    : data.visualType === 'overlay'
    ? 'border-emerald-700'
    : 'border-violet-700';
  return (
    <div className={`h-full overflow-hidden rounded border ${baseColour} ${borderColour} px-2 py-1 text-[10px] leading-tight`}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[9px] text-neutral-500">#{data.rowIndex + 1}</span>
        <span className="truncate text-neutral-200">{data.scriptText || '(no script)'}</span>
        {data.transitionIn === 'cross-fade' && (
          <span title="Cross-fade in" className="ml-auto shrink-0 rounded border border-sky-700 bg-sky-950/60 px-1 font-mono text-[8px] uppercase text-sky-300">
            fade
          </span>
        )}
      </div>
      {data.onScreenText && (
        <p className="truncate text-[9px] text-amber-300">{data.onScreenText}</p>
      )}
      {data.muted && (
        <p className="text-[9px] text-neutral-500">muted</p>
      )}
    </div>
  );
}

function VoiceoverClipCard({ data, selected }: { data: Extract<TimelineActionData['data'], { kind: 'voiceover' }>; selected: boolean }) {
  const borderColour = selected ? 'border-neutral-200 ring-1 ring-neutral-200/50' : 'border-cyan-700';
  return (
    <div className={`h-full overflow-hidden rounded border ${borderColour} bg-cyan-950/60 px-2 py-1 text-[10px] leading-tight`}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[9px] text-neutral-500">🎙</span>
        <span className="truncate text-cyan-100">audio #{data.segmentIndex + 1}</span>
        <span className="ml-auto font-mono text-[8px] text-cyan-400">
          {(data.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      {/* Real waveform decoded from the source URL once + cached.
          Falls back to a static faux pattern while loading or on
          error so the card never goes blank. */}
      <VoiceoverWaveform
        sourceUrl={data.sourceUrl}
        sourceOffsetMs={data.sourceOffsetMs}
        durationMs={data.durationMs}
      />
    </div>
  );
}

/** Static fallback peaks for the loading / error case so the
 *  card never looks broken — same vibe as the M6 ship had before
 *  the deferral landed. */
const FAUX_PEAKS = new Float32Array([0.8, 0.5, 0.9, 0.6, 0.75, 0.45, 0.85, 0.55, 0.7, 0.5, 0.8, 0.6, 0.5, 0.7, 0.55, 0.85, 0.45, 0.75, 0.6, 0.9]);

/** Bucket count rendered as SVG bars per clip. Small enough to
 *  stay cheap on long timelines (100 clips × 32 bars = 3200 rect
 *  elements — well under any DOM budget) while giving enough
 *  resolution to differentiate loud vs quiet sections. */
const WAVE_BUCKETS = 32;

function VoiceoverWaveform({
  sourceUrl, sourceOffsetMs, durationMs,
}: {
  sourceUrl: string;
  sourceOffsetMs: number;
  durationMs: number;
}) {
  const { peaks, durationMs: totalDurationMs, loading, error } = useAudioPeaks(sourceUrl);
  const sliced = useMemo(() => {
    if (!peaks || totalDurationMs <= 0) return null;
    return slicePeaks(peaks, sourceOffsetMs, durationMs, totalDurationMs, WAVE_BUCKETS);
  }, [peaks, totalDurationMs, sourceOffsetMs, durationMs]);

  const bars = sliced ?? FAUX_PEAKS;
  const isReal = sliced !== null;

  return (
    <div className="mt-1 flex h-3 items-end gap-[1px]" title={isReal ? undefined : (loading ? 'Loading waveform…' : error ?? 'Faux waveform (audio not yet decoded)')}>
      {Array.from({ length: bars.length }, (_, i) => {
        const v = bars[i];
        const h = Math.max(4, Math.round(v * 100)); // floor at 4% so silence still shows a sliver
        return (
          <span
            key={i}
            className={isReal ? 'block flex-1 bg-cyan-300' : 'block flex-1 bg-cyan-500/40'}
            style={{ height: `${h}%`, opacity: isReal ? 0.8 : 0.5 }}
          />
        );
      })}
    </div>
  );
}
