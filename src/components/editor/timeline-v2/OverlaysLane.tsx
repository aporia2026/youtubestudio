'use client';

/**
 * Overlays lane — Phase 5 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Renders a small marker on each shot that carries an auto-fetched
 * image overlay. Click the marker jumps the selection to the
 * carrying shot and triggers the inspector to open the overlay
 * position editor.
 *
 * Read-only visually — drag-to-reposition lives in the inspector's
 * existing overlay flow.
 */

import { Layers } from 'lucide-react';
import type { ProductionDoc, RowOverlayRenderState } from '@/remotion/utils';

interface OverlaysLaneProps {
  rows: ProductionDoc['rows'];
  rowStartTimesMs: number[];
  rowOverlays: Record<number, RowOverlayRenderState>;
  totalDurationMs: number;
  pixelsPerSecond: number;
  height: number;
  onSelect: (shotIndex: number) => void;
  onOpenPosition: (shotIndex: number) => void;
}

export function OverlaysLane({
  rows,
  rowStartTimesMs,
  rowOverlays,
  totalDurationMs,
  pixelsPerSecond,
  height,
  onSelect,
  onOpenPosition,
}: OverlaysLaneProps): React.ReactElement {
  const widthPx = Math.max(100, Math.round((totalDurationMs / 1000) * pixelsPerSecond));

  const markers = rows
    .map((_, i) => {
      const overlay = rowOverlays[i];
      if (!overlay || overlay.status !== 'done' || !overlay.url) return null;
      const left = (rowStartTimesMs[i] ?? 0) / 1000 * pixelsPerSecond;
      return { i, left, url: overlay.url };
    })
    .filter((m): m is { i: number; left: number; url: string } => m !== null);

  if (markers.length === 0) {
    return (
      <div
        className="flex items-center px-3"
        style={{
          height,
          background: 'var(--editor-lane-overlays)',
          color: 'var(--fg-muted)',
          fontSize: 10,
          minWidth: widthPx,
        }}
      >
        No overlays
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{
        height,
        background: 'var(--editor-lane-overlays)',
        minWidth: widthPx,
        width: widthPx,
      }}
    >
      {markers.map((m) => (
        <button
          key={m.i}
          type="button"
          className="absolute flex items-center gap-1 px-1.5 rounded-md transition-colors"
          style={{
            left: m.left + 2,
            top: 4,
            height: height - 8,
            background: 'rgba(16, 185, 129, 0.20)',
            border: '1px solid rgba(16, 185, 129, 0.55)',
            color: '#34d399',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(m.i);
            onOpenPosition(m.i);
            console.info('[editor overlays-lane] click', { rowIndex: m.i });
          }}
          title={`Shot ${m.i + 1} overlay — click to edit position`}
        >
          <Layers size={11} strokeWidth={2} />
          <span className="text-[9px] ed-mono">{m.i + 1}</span>
        </button>
      ))}
    </div>
  );
}
