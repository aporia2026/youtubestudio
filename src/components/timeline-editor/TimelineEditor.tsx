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

import { Timeline } from '@xzdarcy/react-timeline-editor';
import { useCallback, useMemo, useRef } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import {
  computeRowIntervals,
  docToTimelineRows,
  totalDocDurationMs,
  type TimelineActionData,
} from './timeline-data-adapter';
import { trimRowDuration } from './timeline-mutations';
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

  // Compute row intervals up-front for the resize handler — we need
  // the row's absolute start in ms to convert the library's
  // (start, end) seconds into a row-local duration.
  const intervals = useMemo(() => computeRowIntervals(doc), [doc]);

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

  // Pixel math: `scale` = seconds per major tick, `scaleWidth` = px
  // per major tick. Together they define ms-per-px.
  //   secondsPerTick × pxPerTick = pxPerSecond → 1000 / pxPerSecond = msPerPx
  // We hold scale at 1 second and derive scaleWidth from msPerPx.
  const scale = 1;
  const scaleWidth = 1000 / msPerPx; // px per second

  return (
    <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/40 p-4 text-sm">
      <header className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-medium text-neutral-100">Timeline</h3>
          <p className="text-xs text-neutral-400">
            {doc.rows.length} clips · {totalSec.toFixed(1)}s · {fps} fps
          </p>
        </div>
        <p className="text-[10px] text-emerald-400">
          {editable
            ? 'M2 — drag a clip edge to trim. Split / cut / reorder coming in M3–M5.'
            : 'Read-only.'}
        </p>
      </header>

      <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950">
        <Timeline
          editorData={rows}
          effects={TIMELINE_EFFECTS}
          onChange={() => { /* M2 wires this. M1 is read-only. */ }}
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
            return <ClipCard data={data} />;
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

function ClipCard({ data }: { data: TimelineActionData['data'] }) {
  const colour =
    data.visualType === 'stock'
      ? 'border-amber-700 bg-amber-950/60'
      : data.visualType === 'overlay'
      ? 'border-emerald-700 bg-emerald-950/60'
      : 'border-violet-700 bg-violet-950/60';
  return (
    <div className={`h-full overflow-hidden rounded border ${colour} px-2 py-1 text-[10px] leading-tight`}>
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
