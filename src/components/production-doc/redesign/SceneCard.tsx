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
export type SceneCardOrientation = 'horizontal' | 'vertical';

/** Per-card video clip status. Mirrors the shape page.tsx already
 *  produces; widened to `string` so unknown statuses don't break the
 *  card (polish PR). */
export interface SceneCardVideoState {
  status: string;
}

export interface SceneCardProps {
  /** 0-based index into `doc.rows`. */
  rowIndex: number;
  row: ProductionRow;
  /** Image state for this row (drives the thumbnail). Optional —
   *  when absent / not 'done', the card shows the placeholder. */
  imageState?: RowImageStateView;
  /** Video clip state for this row (drives the V badge). Optional. */
  videoState?: SceneCardVideoState | null;
  /** Whether this card is the currently-selected one. */
  selected?: boolean;
  /** Called with the 0-based index when the user activates the card. */
  onSelect?: (rowIndex: number) => void;
  /** Layout direction. Default `'horizontal'` (R4 PR1 default).
   *  Vertical mode renders a Notion-row layout: thumbnail left,
   *  content middle, badges right. R4 PR2. */
  orientation?: SceneCardOrientation;
}

const SCRIPT_PREVIEW_MAX = 80;

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

type VideoBadgeState = 'ready' | 'generating' | 'failed' | null;

function videoBadgeState(s: SceneCardVideoState | null | undefined): VideoBadgeState {
  if (!s) return null;
  if (s.status === 'ready') return 'ready';
  if (s.status === 'failed') return 'failed';
  if (s.status === 'generating' || s.status === 'starting' || s.status === 'pending') {
    return 'generating';
  }
  return null;
}

const VIDEO_BADGE_COLOR: Record<NonNullable<VideoBadgeState>, string> = {
  ready: '#34d399',
  generating: '#a78bfa',
  failed: '#f87171',
};

const VIDEO_BADGE_TITLE: Record<NonNullable<VideoBadgeState>, string> = {
  ready: 'B-roll clip ready',
  generating: 'B-roll generating',
  failed: 'B-roll generation failed',
};

export const SceneCard: React.FC<SceneCardProps> = ({
  rowIndex,
  row,
  imageState,
  videoState,
  selected = false,
  onSelect,
  orientation = 'horizontal',
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
  const videoBadge = videoBadgeState(videoState);

  const label = `Scene ${displayIndex}${row.timecode ? ` at ${row.timecode}` : ''}`;

  if (orientation === 'vertical') {
    return (
      <button
        type="button"
        onClick={onSelect ? () => onSelect(rowIndex) : undefined}
        disabled={!onSelect}
        aria-pressed={onSelect ? selected : undefined}
        aria-label={label}
        data-orientation="vertical"
        className="flex items-stretch w-full text-left rounded overflow-hidden transition-colors"
        style={{
          minHeight: 56,
          background: selected
            ? 'rgba(124,58,237,0.10)'
            : 'rgba(255,255,255,0.03)',
          border: selected
            ? '1px solid var(--accent-purple-bright, #a78bfa)'
            : '1px solid rgba(255,255,255,0.08)',
          cursor: onSelect ? 'pointer' : 'default',
          borderLeftWidth: selected ? 3 : 1,
        }}
      >
        <div
          className="relative shrink-0"
          style={{
            width: 84,
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
              className="absolute inset-0 flex items-center justify-center text-[9px]"
              style={{ color: 'var(--text-muted)' }}
            >
              no image
            </div>
          )}
          <span
            className="absolute top-0.5 left-0.5 inline-flex items-center justify-center rounded text-[9px] font-semibold"
            style={{
              minWidth: 16,
              height: 14,
              padding: '0 3px',
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
            }}
          >
            {displayIndex}
          </span>
        </div>
        <div className="flex-1 min-w-0 px-2 py-1.5 flex flex-col justify-center">
          <div className="flex items-baseline gap-2">
            {row.timecode && (
              <span
                className="text-[10px] font-mono shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {row.timecode}
              </span>
            )}
            {visualType && visualTypeColor && (
              <span
                className="inline-flex items-center text-[9px] px-1.5 py-px rounded-full shrink-0"
                style={{
                  background: visualTypeColor.bg,
                  color: visualTypeColor.color,
                }}
              >
                {visualType}
              </span>
            )}
          </div>
          <div
            className="text-[11px] leading-snug truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {truncate(row.script_text ?? '', SCRIPT_PREVIEW_MAX)}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="shrink-0 flex items-center gap-1 px-2"
        >
          {videoBadge && (
            <span
              title={VIDEO_BADGE_TITLE[videoBadge]}
              className="text-[9px] px-1 rounded"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: VIDEO_BADGE_COLOR[videoBadge],
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              V
            </span>
          )}
          {hasOst && (
            <span
              title="On-screen text"
              className="text-[9px] px-1 rounded"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: '#fbbf24',
                border: '1px solid rgba(255,255,255,0.08)',
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
                background: 'rgba(255,255,255,0.04)',
                color: '#fbbf24',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              ✦
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect ? () => onSelect(rowIndex) : undefined}
      disabled={!onSelect}
      aria-pressed={onSelect ? selected : undefined}
      aria-label={label}
      data-orientation="horizontal"
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
          {videoBadge && (
            <span
              title={VIDEO_BADGE_TITLE[videoBadge]}
              className="text-[9px] px-1 rounded"
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: VIDEO_BADGE_COLOR[videoBadge],
              }}
            >
              V
            </span>
          )}
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
