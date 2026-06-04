'use client';

import React, { useMemo, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import {
  SceneCard,
  type SceneCardOrientation,
  type SceneCardVideoState,
} from './SceneCard';

export type SceneStripOrientation = SceneCardOrientation;

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
  /** Per-row video clip state. Drives the V badge on each card. */
  rowVideoClipsByIndex?: Readonly<Record<number, SceneCardVideoState | null>>;
  /** 0-based selected row index, or `null` when nothing is selected. */
  selectedRowIndex?: number | null;
  /** Called with the 0-based index when the user activates a card. */
  onSelectRow?: (rowIndex: number) => void;
  /** Layout direction. Default `'horizontal'`. R4 PR2. */
  orientation?: SceneStripOrientation;
}

export const SceneStrip: React.FC<SceneStripProps> = ({
  doc,
  rowImagesByIndex,
  rowVideoClipsByIndex,
  selectedRowIndex = null,
  onSelectRow,
  orientation = 'horizontal',
}) => {
  const rows = doc.rows ?? [];
  // Jump-to-scene search. Filters the visible cards by case-insensitive
  // substring match against scene index, timecode, script_text,
  // visual_description, and section_title. Hidden when there are
  // fewer than 6 scenes (the strip is short enough to scan visually).
  const [searchQuery, setSearchQuery] = useState('');
  const filteredIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows.map((_, idx) => idx);
    return rows
      .map((row, idx) => {
        const haystack = [
          String(idx + 1),
          row.timecode ?? '',
          row.script_text ?? '',
          row.visual_description ?? '',
          row.section_title ?? '',
          row.visual_type ?? '',
        ]
          .join('  ')
          .toLowerCase();
        return haystack.includes(q) ? idx : -1;
      })
      .filter((idx) => idx >= 0);
  }, [rows, searchQuery]);
  const showSearch = rows.length >= 6;
  const hiddenCount = rows.length - filteredIndices.length;

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
        {showSearch && (
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Jump to scene…"
            aria-label="Search scenes"
            className="text-[11px] rounded px-2 py-0.5 flex-1 max-w-[200px]"
            style={{
              background: 'rgba(0,0,0,0.25)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
          />
        )}
        <span
          className="text-[10px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {hiddenCount > 0
            ? `${filteredIndices.length} of ${rows.length}`
            : `${rows.length} ${rows.length === 1 ? 'scene' : 'scenes'}`}
        </span>
      </header>
      <div
        role="list"
        aria-label="Scene cards"
        data-orientation={orientation}
        className={
          orientation === 'vertical'
            ? 'px-3 pb-3 flex flex-col gap-1.5 max-h-[480px] overflow-y-auto'
            : 'px-3 pb-3 flex items-stretch gap-2 overflow-x-auto'
        }
        style={
          orientation === 'vertical'
            ? { scrollbarWidth: 'thin' }
            : {
                scrollSnapType: 'x mandatory',
                // keep the scrollbar visible at the bottom so the
                // affordance is obvious — overflow-x-auto by itself
                // hides it on macOS.
                scrollbarWidth: 'thin',
              }
        }
      >
        {filteredIndices.map((idx) => {
          const row = rows[idx];
          return (
            <div
              key={idx}
              role="listitem"
              style={
                orientation === 'horizontal'
                  ? { scrollSnapAlign: 'start' }
                  : undefined
              }
            >
              <SceneCard
                rowIndex={idx}
                row={row}
                imageState={rowImagesByIndex?.[idx]}
                videoState={rowVideoClipsByIndex?.[idx] ?? null}
                selected={selectedRowIndex === idx}
                onSelect={onSelectRow}
                orientation={orientation}
              />
            </div>
          );
        })}
        {filteredIndices.length === 0 && searchQuery && (
          <div
            className="text-xs px-3 py-4 italic"
            style={{ color: 'var(--text-muted)' }}
          >
            No scenes match "{searchQuery}".
          </div>
        )}
      </div>
    </section>
  );
};
