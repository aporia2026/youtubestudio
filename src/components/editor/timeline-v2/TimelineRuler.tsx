'use client';

/**
 * Time ruler for the multi-lane timeline.
 *
 * Phase 5 of `_plans/2026-05-19-editor-real-nle-look.md`. Renders
 * time labels above the lanes — 0:00, 0:05, 0:10, etc. — with the
 * interval auto-chosen based on `pixelsPerSecond` so the labels
 * never overlap.
 *
 * Click anywhere on the ruler to seek the playhead. Doesn't render
 * the playhead itself — that's TimelineV2's job (one playhead spans
 * every lane including the ruler).
 */

import { useMemo, useCallback } from 'react';

interface TimelineRulerProps {
  totalDurationMs: number;
  pixelsPerSecond: number;
  onSeek: (ms: number) => void;
}

function fmtClock(s: number): string {
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** Pick an interval in seconds so labels are ≥ MIN_LABEL_PX apart. */
function pickInterval(pxPerSec: number): number {
  const MIN_LABEL_PX = 60;
  const minSec = MIN_LABEL_PX / Math.max(1, pxPerSec);
  // Round up to the next nice interval. The ladder grows
  // geometrically so a tight zoom uses 1s, a loose zoom uses 30s.
  const ladder = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const candidate of ladder) {
    if (candidate >= minSec) return candidate;
  }
  return 600;
}

export function TimelineRuler({
  totalDurationMs,
  pixelsPerSecond,
  onSeek,
}: TimelineRulerProps): React.ReactElement {
  const totalSec = totalDurationMs / 1000;
  const interval = useMemo(() => pickInterval(pixelsPerSecond), [pixelsPerSecond]);

  const labels = useMemo(() => {
    const out: Array<{ sec: number; px: number }> = [];
    for (let s = 0; s <= totalSec; s += interval) {
      out.push({ sec: s, px: s * pixelsPerSecond });
    }
    return out;
  }, [totalSec, interval, pixelsPerSecond]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
      const ms = Math.max(0, Math.round((x / pixelsPerSecond) * 1000));
      onSeek(Math.min(ms, totalDurationMs));
    },
    [pixelsPerSecond, onSeek, totalDurationMs],
  );

  return (
    <div
      className="relative cursor-pointer select-none"
      onClick={handleClick}
      style={{
        height: 22,
        background: 'var(--editor-panel)',
        borderBottom: '1px solid var(--editor-edge)',
        minWidth: '100%',
        flexShrink: 0,
      }}
      title="Click to seek the playhead"
    >
      {labels.map((label) => (
        <div
          key={label.sec}
          className="absolute top-0 bottom-0 ed-mono"
          style={{ left: label.px, paddingLeft: 4, fontSize: 10, color: 'var(--fg-muted)' }}
        >
          <span style={{ borderLeft: '1px solid var(--editor-edge)', paddingLeft: 4, lineHeight: '22px' }}>
            {fmtClock(label.sec)}
          </span>
        </div>
      ))}
    </div>
  );
}
