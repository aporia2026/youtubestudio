'use client';

import React, { useEffect, useState } from 'react';
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

/** Mini motion-collage grid preview rendered in place of the single
 *  thumbnail when the row is a motion_collage row. Matches the
 *  legacy ImageCell's grid preview semantics. */
const MotionCollageMiniGrid: React.FC<{
  panels: ReadonlyArray<string>;
  grid: { cols: number; rows: number } | null;
}> = ({ panels, grid }) => {
  const cols = grid?.cols ?? Math.ceil(Math.sqrt(panels.length || 1));
  const rows = grid?.rows ?? Math.ceil((panels.length || 1) / cols);
  const cells = cols * rows;
  return (
    <div
      className="absolute inset-0 grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 1,
        background: 'rgba(0,0,0,0.5)',
      }}
      aria-label="Motion collage panels preview"
    >
      {Array.from({ length: cells }, (_, i) => {
        const url = panels[i];
        return (
          <div
            key={i}
            className="overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
  // Motion collage cards show the row's per-panel keyframes as a
  // mini grid (NEW) — matches the legacy ImageCell's collage preview.
  const isMotionCollage = row.shot_kind === 'motion_collage';
  const motionPanels = isMotionCollage && row.motion_collage_panel_urls?.length
    ? row.motion_collage_panel_urls
    : null;
  const motionGrid = row.motion_collage_grid ?? null;
  const hasOverlay = !!row.overlay_stock_terms?.trim();
  const hasOst = !!row.on_screen_text?.trim();
  const videoBadge = videoBadgeState(videoState);
  // Thumbnail zoom (NEW): clicking a magnifier icon on the thumbnail
  // opens a fullscreen lightbox so the user can inspect the image
  // without leaving the inspector. Esc closes; click outside closes.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomed(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  // QA fix: show in-flight image generation progress so cards aren't
  // just "no image" silent during long runs. Maps the underlying
  // RowImageStateView statuses onto user-facing labels + colors.
  const imageStatusLabel: { label: string; color: string } | null = (() => {
    const status = imageState?.status;
    if (!status || status === 'done') return null;
    if (status === 'pending' || status === 'loading') {
      return { label: 'Generating…', color: '#a78bfa' };
    }
    if (status === 'uploading') return { label: 'Uploading…', color: '#a78bfa' };
    if (status === 'editing') return { label: 'Editing…', color: '#fbbf24' };
    if (status === 'search') return { label: 'Searching…', color: '#60a5fa' };
    if (status === 'error') return { label: 'Failed', color: '#f87171' };
    return null;
  })();

  const label = `Scene ${displayIndex}${row.timecode ? ` at ${row.timecode}` : ''}`;

  // Render the zoom lightbox once, outside both layout branches.
  const lightbox = zoomed && thumbnailUrl ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Zoomed image for ${label}`}
      onClick={() => setZoomed(false)}
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(4px)',
        cursor: 'zoom-out',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbnailUrl}
        alt={`Scene ${displayIndex} image`}
        className="max-w-full max-h-full object-contain"
        style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
        aria-label="Close zoom"
        className="fixed top-4 right-4 text-2xl px-3 py-1 rounded"
        style={{
          background: 'rgba(255,255,255,0.08)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.15)',
          cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  ) : null;

  if (orientation === 'vertical') {
    return (
      <>
      <button
        type="button"
        onClick={onSelect ? () => onSelect(rowIndex) : undefined}
        onDoubleClick={thumbnailUrl ? () => setZoomed(true) : undefined}
        disabled={!onSelect}
        aria-pressed={onSelect ? selected : undefined}
        aria-label={label}
        title={thumbnailUrl ? 'Double-click to zoom the image' : undefined}
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
          ) : imageStatusLabel ? (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center text-[9px] gap-0.5 px-1 text-center"
              style={{ color: imageStatusLabel.color }}
            >
              {(imageState?.status === 'pending' ||
                imageState?.status === 'loading' ||
                imageState?.status === 'uploading' ||
                imageState?.status === 'editing' ||
                imageState?.status === 'search') && (
                <span aria-hidden="true" className="animate-pulse">●●●</span>
              )}
              <span>{imageStatusLabel.label}</span>
            </div>
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
      {lightbox}
      </>
    );
  }

  return (
    <>
    <button
      type="button"
      onClick={onSelect ? () => onSelect(rowIndex) : undefined}
      onDoubleClick={thumbnailUrl ? () => setZoomed(true) : undefined}
      disabled={!onSelect}
      aria-pressed={onSelect ? selected : undefined}
      aria-label={label}
      title={thumbnailUrl ? 'Double-click to zoom the image' : undefined}
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
        {motionPanels ? (
          <MotionCollageMiniGrid panels={motionPanels} grid={motionGrid} />
        ) : thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : imageStatusLabel ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center text-[10px] gap-1"
            style={{ color: imageStatusLabel.color }}
          >
            {(imageState?.status === 'pending' ||
              imageState?.status === 'loading' ||
              imageState?.status === 'uploading' ||
              imageState?.status === 'editing' ||
              imageState?.status === 'search') && (
              <span aria-hidden="true" className="animate-pulse">●●●</span>
            )}
            <span>{imageStatusLabel.label}</span>
          </div>
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
    {lightbox}
    </>
  );
};
