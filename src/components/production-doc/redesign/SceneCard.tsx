'use client';

import React from 'react';
import type { ProductionRow } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import { getVisualTypeColor } from '@/lib/visual-type-colors';

/**
 * SceneCard — single scene card used by `SceneStrip`. See
 * `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the target
 * card design.
 *
 * Card content (horizontal mode, this PR):
 *   - 16:9 thumbnail (or placeholder when image not ready)
 *   - 1-based row number
 *   - Timecode
 *   - Short script preview (first ~40 chars)
 *   - Visual-type pill (color-tokened, shared with StudioLegend)
 *   - Selected-state highlight ring when this row is the active one
 *
 * Click semantics: the entire card is the affordance — wrapped in a
 * `<button>` so it gets focus + keyboard activation for free.
 * Selection feedback is `aria-pressed`.
 *
 * Status pills for video / overlay / variant land in a follow-up
 * polish PR; this PR keeps the card minimal to ship the layout
 * architecture cleanly.
 */
export interface SceneCardProps {
  /** 0-based index into `doc.rows`. */
  rowIndex: number;
  row: ProductionRow;
  /** Image state for this row (drives the thumbnail). Optional —
   *  when absent / not 'done', the card shows the placeholder. */
  imageState?: RowImageStateView;
  /** Whether this card is the currently-selected one. */
  selected?: boolean;
  /** Called with the 0-based index when the user activates the card. */
  onSelect?: (rowIndex: number) => void;
}

const SCRIPT_PREVIEW_MAX = 80;

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

export const SceneCard: React.FC<SceneCardProps> = ({
  rowIndex,
  row,
  imageState,
  selected = false,
  onSelect,
}) => {
  const displayIndex = rowIndex + 1;
  const visualType = row.visual_type?.trim() ?? '';
  const visualTypeColor = visualType ? getVisualTypeColor(visualType) : null;
  const thumbnailUrl =
    imageState?.status === 'done' && imageState.imageUrl
      ? imageState.imageUrl
      : null;
  const hasOverlay = !!row.overlay_stock_terms?.trim();
  const hasOst = !!row.on_screen_text?.trim();

  const label = `Scene ${displayIndex}${row.timecode ? ` at ${row.timecode}` : ''}`;

  return (
    <button
      type="button"
      onClick={onSelect ? () => onSelect(rowIndex) : undefined}
      disabled={!onSelect}
      aria-pressed={selected}
      aria-label={label}
      className="flex flex-col text-left rounded overflow-hidden transition-colors"
      style={{
        width: 160,
        minWidth: 160,
        background: selected
          ? 'rgba(124,58,237,0.10)'
          : 'rgba(255,255,255,0.03)',
        border: selected
          ? '1px solid var(--accent-purple-bright, #a78bfa)'
          : '1px solid rgba(255,255,255,0.08)',
        cursor: onSelect ? 'pointer' : 'default',
      }}
    >
      <div
        className="relative w-full"
        style={{
          aspectRatio: '16 / 9',
          background: 'rgba(0,0,0,0.25)',
        }}
      >
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center text-[10px]"
            style={{ color: 'var(--text-muted)' }}
          >
            no image
          </div>
        )}
        <span
          className="absolute top-1 left-1 inline-flex items-center justify-center rounded text-[10px] font-semibold"
          style={{
            minWidth: 18,
            height: 16,
            padding: '0 4px',
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
          }}
        >
          {displayIndex}
        </span>
        <span
          aria-hidden="true"
          className="absolute bottom-1 right-1 inline-flex items-center gap-0.5"
        >
          {hasOst && (
            <span
              title="On-screen text"
              className="text-[9px] px-1 rounded"
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: '#fbbf24',
              }}
            >
              T
            </span>
          )}
          {hasOverlay && (
            <span
              title="Overlay"
              className="text-[9px] px-1 rounded"
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: '#fbbf24',
              }}
            >
              ✦
            </span>
          )}
        </span>
      </div>
      <div className="px-2 py-1.5 space-y-1">
        {row.timecode && (
          <div
            className="text-[10px] font-mono"
            style={{ color: 'var(--text-muted)' }}
          >
            {row.timecode}
          </div>
        )}
        <div
          className="text-[11px] leading-snug"
          style={{
            color: 'var(--text-primary)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {truncate(row.script_text ?? '', SCRIPT_PREVIEW_MAX)}
        </div>
        {visualType && visualTypeColor && (
          <span
            className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full"
            style={{
              background: visualTypeColor.bg,
              color: visualTypeColor.color,
            }}
          >
            {visualType}
          </span>
        )}
      </div>
    </button>
  );
};
