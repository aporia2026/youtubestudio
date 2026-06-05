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
import { useMemo } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import {
  docToTimelineRows,
  totalDocDurationMs,
  type TimelineActionData,
} from './timeline-data-adapter';
import { msToSec, DEFAULT_FPS } from '@/lib/timeline-editor/frame-math';

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
  // M2 will start using onDocChange; intentionally unused here.
  onDocChange: _onDocChange,
  msPerPx = 62.5,
  fps = DEFAULT_FPS,
}: TimelineEditorProps) {
  const rows = useMemo(() => docToTimelineRows(doc), [doc]);
  const totalSec = useMemo(() => msToSec(totalDocDurationMs(doc)), [doc]);

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
        <p className="text-[10px] text-amber-400">
          M1 — read-only. Trim/split/cut/reorder coming in M2–M5.
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
          // Block edits in M1 — return false from every change
          // callback so a user can pan/zoom but can't accidentally
          // mutate state before the wiring lands in M2.
          onActionResizing={() => false}
          onActionMoving={() => false}
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
