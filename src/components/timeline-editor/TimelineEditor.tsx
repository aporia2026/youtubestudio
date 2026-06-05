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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import {
  docToTimelineRows,
  totalDocDurationMs,
  type TimelineActionData,
} from './timeline-data-adapter';
import { cutRow, splitRowAtPlayheadMs, trimRowDuration } from './timeline-mutations';
import { msToSec, secToMs, DEFAULT_FPS } from '@/lib/timeline-editor/frame-math';

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
  /** Called after the user commits any edit (M2+). M1 keeps this
   *  optional because the editor is mounted read-only first. */
  onDocChange?: (doc: ProductionDoc) => void;
  /** ms per pixel at the default zoom. Default fits a 60-second
   *  doc in ~960 px (typical /video-studio container width). */
  msPerPx?: number;
  /** Frames per second for snap. Defaults to the renderer's fps. */
  fps?: number;
}

export function TimelineEditor({
  doc,
  onDocChange,
  msPerPx = 62.5,
  fps = DEFAULT_FPS,
}: TimelineEditorProps) {
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
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
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

  const handleResizing = useCallback(
    (args: { action: { id: string; data?: TimelineActionData['data'] }; start: number; end: number; dir: 'left' | 'right' }) => {
      if (!onDocChange) return false; // read-only
      const rowIndex = args.action.data?.rowIndex ?? -1;
      if (rowIndex < 0) return false;
      const newDurationMs = secToMs(args.end - args.start);
      const next = trimRowDuration(docRef.current, rowIndex, newDurationMs, { fps });
      if (next !== docRef.current) {
        onDocChange(next);
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
      // ResizeEnd. Re-running trimRowDuration here is a no-op when
      // the value matches but cheap insurance against drift.
      if (!onDocChange) return;
      const rowIndex = args.action.data?.rowIndex ?? -1;
      if (rowIndex < 0) return;
      const newDurationMs = secToMs(args.end - args.start);
      const next = trimRowDuration(docRef.current, rowIndex, newDurationMs, { fps });
      if (next !== docRef.current) {
        onDocChange(next);
      }
    },
    [onDocChange, fps],
  );

  const editable = onDocChange !== undefined;

  // M3: subscribe to the library's tick + cursor-drag events so we
  // know where the playhead sits when the user presses `S`. The
  // listener is mounted once on first render; offAll on unmount.
  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    const onTick = ({ time }: { time: number }) => setPlayheadSec(time);
    tl.listener.on('setTimeByTick', onTick);
    tl.listener.on('afterSetTime', onTick);
    return () => {
      tl.listener.offAll();
    };
  }, []);

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
      if (e.key === 's' || e.key === 'S') {
        const next = splitRowAtPlayheadMs(docRef.current, secToMs(playheadSec), { fps });
        if (next !== docRef.current) {
          e.preventDefault();
          onDocChange(next);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedRowIndex === null) return;
        const next = cutRow(docRef.current, selectedRowIndex);
        if (next !== docRef.current) {
          e.preventDefault();
          onDocChange(next);
          setSelectedRowIndex(null);
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [editable, onDocChange, fps, playheadSec, selectedRowIndex]);

  // Click on a clip selects it (the Del key uses this).
  const handleClickAction = useCallback(
    (_e: React.MouseEvent, args: { action: { id: string; data?: TimelineActionData['data'] } }) => {
      setSelectedRowIndex(args.action.data?.rowIndex ?? null);
    },
    [],
  );

  // Header buttons for users without keyboards (or who want explicit
  // affordances). Wraps the same mutation helpers the keymap calls.
  const handleSplitClick = useCallback(() => {
    if (!onDocChange) return;
    const next = splitRowAtPlayheadMs(docRef.current, secToMs(playheadSec), { fps });
    if (next !== docRef.current) onDocChange(next);
  }, [onDocChange, fps, playheadSec]);

  const handleCutClick = useCallback(() => {
    if (!onDocChange || selectedRowIndex === null) return;
    const next = cutRow(docRef.current, selectedRowIndex);
    if (next !== docRef.current) {
      onDocChange(next);
      setSelectedRowIndex(null);
    }
  }, [onDocChange, selectedRowIndex]);

  // Pixel math: `scale` = seconds per major tick, `scaleWidth` = px
  // per major tick. Together they define ms-per-px.
  //   secondsPerTick × pxPerTick = pxPerSecond → 1000 / pxPerSecond = msPerPx
  // We hold scale at 1 second and derive scaleWidth from msPerPx.
  const scale = 1;
  const scaleWidth = 1000 / msPerPx; // px per second

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
            {selectedRowIndex !== null && <> · selected clip #{selectedRowIndex + 1}</>}
          </p>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
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
              disabled={selectedRowIndex === null}
              title="Delete selected clip (Del)"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-200 hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ✕ Cut · Del
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
          style={{ height: 140, width: '100%' }}
          getActionRender={(action) => {
            const data = (action as { data?: TimelineActionData['data'] }).data ?? {
              rowIndex: -1,
              scriptText: '',
              visualType: 'ai_image',
              imageUrl: '',
              onScreenText: '',
              muted: false,
            };
            return <ClipCard data={data} selected={selectedRowIndex === data.rowIndex} />;
          }}
          // M2: drag-trim/drag-resize wired into trimRowDuration.
          // Library hands us (start, end) seconds; we convert to
          // ms, snap to frame, write `duration_override_ms`.
          // dir='left' and dir='right' collapse to the same op
          // because the doc model is cumulative — moving the left
          // edge or the right edge both change THIS row's duration.
          // M3 will add split (S key) + cut (Del); M4 wires reorder
          // by un-blocking onActionMoving.
          onActionResizing={editable ? handleResizing : () => false}
          onActionResizeEnd={editable ? handleResizeEnd : undefined}
          onActionMoving={() => false}
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
