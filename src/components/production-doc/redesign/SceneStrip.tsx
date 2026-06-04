'use client';

import React from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import { SceneCard } from './SceneCard';

/**
 * SceneStrip — horizontal scroll-bar of scene cards. See
 * `_plans/2026-06-04-production-doc-redesign.md` §4.2 / §15.1.
 *
 * R4 PR1 (this PR) ships the horizontal orientation only — that's
 * the documented default per §15.2. R4 PR2 adds the vertical
 * Notion-row variant plus the orientation toggle in the top bar
 * (the user opted into shipping both per §15.1).
 *
 * Selection: clicking a card fires `onSelectRow` with the 0-based
 * row index. The shell maps that to `expandedRow` so the inspector
 * populates with the same row.
 *
 * Drag-to-reorder lands in a follow-up PR — the keyboard / aria
 * surface for reorder needs its own design pass.
 */
export interface SceneStripProps {
  doc: ProductionDoc;
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** 0-based selected row index, or `null` when nothing is selected. */
  selectedRowIndex?: number | null;
  /** Called with the 0-based index when the user activates a card. */
  onSelectRow?: (rowIndex: number) => void;
}

export const SceneStrip: React.FC<SceneStripProps> = ({
  doc,
  rowImagesByIndex,
  selectedRowIndex = null,
  onSelectRow,
}) => {
  const rows = doc.rows ?? [];
  if (rows.length === 0) {
    return (
      <div
        className="text-xs px-3 py-6 text-center rounded"
        style={{
          color: 'var(--text-muted)',
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.08)',
        }}
      >
        No scenes yet. Generate a production doc to see scene cards here.
      </div>
    );
  }

  return (
    <section
      aria-label="Scene strip"
      className="rounded"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <header className="px-3 py-2 flex items-baseline justify-between gap-3">
        <h2
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          Scenes
        </h2>
        <span
          className="text-[10px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {rows.length} {rows.length === 1 ? 'scene' : 'scenes'}
        </span>
      </header>
      <div
        role="list"
        aria-label="Scene cards"
        className="px-3 pb-3 flex items-stretch gap-2 overflow-x-auto"
        style={{
          scrollSnapType: 'x mandatory',
          // keep the scrollbar visible at the bottom so the affordance
          // is obvious — overflow-x-auto by itself hides it on macOS.
          scrollbarWidth: 'thin',
        }}
      >
        {rows.map((row, idx) => (
          <div
            key={idx}
            role="listitem"
            style={{ scrollSnapAlign: 'start' }}
          >
            <SceneCard
              rowIndex={idx}
              row={row}
              imageState={rowImagesByIndex?.[idx]}
              selected={selectedRowIndex === idx}
              onSelect={onSelectRow}
            />
          </div>
        ))}
      </div>
    </section>
  );
};
