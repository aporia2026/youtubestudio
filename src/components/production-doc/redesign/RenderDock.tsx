'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  type ImageScopeKind,
  scopeLabel,
  scopeOverwritesExistingImages,
} from '@/lib/production-doc-image-scopes';

/**
 * RenderDock — pinned-bottom batch + render bar in Studio Mode. See
 * `_plans/2026-06-04-production-doc-redesign.md` §4.2 / §3.9.
 *
 * Shows at-a-glance media counters (images ready / videos ready /
 * failures) plus a primary "Start Render" CTA. Renders nothing
 * useful when no callbacks are wired, so it stays out of Brief Mode
 * and tests that don't opt in.
 *
 * Phase R5 PR1 (this PR) ships the counters + render trigger +
 * download link. Batch operations (Retry all failed, Animate all)
 * land in R5 PR2 once their writers are plumbed through. Per rule 10
 * no orphan buttons.
 *
 * The dock is positioned `fixed; bottom: 0` and styled to span the
 * viewport. The Studio layout adds bottom padding so the last row of
 * inspector / scene strip content isn't covered by the dock.
 */
export type RenderDockStatus = 'idle' | 'rendering' | 'done' | 'error';

export interface RenderDockMediaStats {
  /** Items in a final-ready state. */
  ready: number;
  /** Items in an explicit failure state. Drives the warning chip. */
  failed: number;
  /** Total items in scope (= doc.rows.length for image/video). */
  total: number;
}

export type RenderDockBatchKind =
  | 'animate'
  | 'retry-images'
  | 'retry-videos'
  | 'image-scope';

export interface RenderDockBatchProgress {
  kind: RenderDockBatchKind;
  done: number;
  total: number;
}

export interface RenderDockProps {
  imageStats: RenderDockMediaStats;
  videoStats: RenderDockMediaStats;
  status: RenderDockStatus;
  /** 0–100 render progress. Only meaningful when `status === 'rendering'`. */
  progress?: number;
  /** HTTPS link to the finished MP4 when `status === 'done'`. */
  downloadUrl?: string;
  /** Last error message when `status === 'error'`. */
  errorMessage?: string;
  /** Primary action. Disabled while rendering. */
  onStartRender?: () => void;
  /** Retry every row whose image is in 'error' state. Hidden when
   *  the callback is undefined or there are no failed images. R5 PR2. */
  onRetryFailedImages?: () => void;
  /** Retry every row whose B-roll clip is in 'failed' state. Hidden
   *  when the callback is undefined or there are no failed clips. R5 PR2. */
  onRetryFailedVideos?: () => void;
  /** Kick off B-roll generation for every row that doesn't have a
   *  clip yet. R5 PR2. */
  onAnimateAll?: () => void;
  /** When non-null, a batch is in flight. The matching button shows
   *  a progress label; all batch buttons disable. R5 PR2. */
  batchInFlight?: RenderDockBatchProgress | null;
  /** Live row-counts per image-generation scope. Drives the
   *  "Generate images ▾" dropdown items. When undefined the
   *  dropdown is hidden. See `_plans/2026-06-05-prodoc-scoped-image-generation.md`. */
  imageScopeCounts?: Record<ImageScopeKind, number>;
  /** Dispatcher for a scoped image-generation batch. The dock
   *  handles the confirm-once safety for overwriting scopes
   *  before calling this; page.tsx routes to the right
   *  helper (runGenerateEmptyImages / runRetryFailedImages / the
   *  new type-based loop). */
  onGenerateImagesByScope?: (scope: ImageScopeKind) => void;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? singular + 's'}`;
}

const STATUS_COLOR: Record<RenderDockStatus, { bg: string; fg: string }> = {
  idle:      { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' },
  rendering: { bg: 'rgba(124,58,237,0.18)',  fg: '#a78bfa' },
  done:      { bg: 'rgba(16,185,129,0.15)',  fg: '#34d399' },
  error:     { bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
};

const STATUS_LABEL: Record<RenderDockStatus, string> = {
  idle: 'Idle',
  rendering: 'Rendering…',
  done: 'Done',
  error: 'Failed',
};

const COUNTER_PILL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-secondary)',
  border: '1px solid rgba(255,255,255,0.08)',
};

const FAILED_PILL_STYLE: React.CSSProperties = {
  background: 'rgba(239,68,68,0.10)',
  color: '#f87171',
  border: '1px solid rgba(239,68,68,0.25)',
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  background: 'var(--accent-purple-bright, #a78bfa)',
  color: '#0a0a0a',
  border: 'none',
  cursor: 'pointer',
  fontWeight: 600,
};

export const RenderDock: React.FC<RenderDockProps> = ({
  imageStats,
  videoStats,
  status,
  progress,
  downloadUrl,
  errorMessage,
  onStartRender,
  onRetryFailedImages,
  onRetryFailedVideos,
  onAnimateAll,
  batchInFlight = null,
  imageScopeCounts,
  onGenerateImagesByScope,
}) => {
  // Generate-images dropdown state. Plain React state; the popover
  // is local DOM, no portal — outside-click closes via a document
  // listener so the popover behaves like a real menu.
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scopeMenuOpen) return;
    function handleDocClick(e: MouseEvent) {
      if (!scopeMenuRef.current) return;
      if (!scopeMenuRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setScopeMenuOpen(false);
    }
    document.addEventListener('mousedown', handleDocClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [scopeMenuOpen]);

  const handleScopeClick = (scope: ImageScopeKind, count: number) => {
    if (count === 0) return;
    if (!onGenerateImagesByScope) return;
    console.info('[prodoc image-scope] scope-selected', { scope, count });
    if (scopeOverwritesExistingImages(scope)) {
      const label = scopeLabel(scope);
      const noun = count === 1 ? 'row' : 'rows';
      const msg =
        scope === 'all'
          ? `Re-generate images for ALL ${count} ${noun}? This will replace every existing image in the doc.`
          : `Re-generate ${label.toLowerCase()} (${count} ${noun})? Any existing images on these rows will be replaced.`;
      console.info('[prodoc image-scope] confirm-shown', { scope, count });
      const confirmed = window.confirm(msg);
      if (!confirmed) {
        console.info('[prodoc image-scope] confirm-cancelled', { scope });
        return;
      }
    }
    setScopeMenuOpen(false);
    onGenerateImagesByScope(scope);
  };

  const stateScopes: ImageScopeKind[] = ['empty', 'failed'];
  const typeScopes: ImageScopeKind[] = [
    'animation',
    'motion_collage',
    'base_variant',
    'non_base_variant',
    'title_card',
  ];

  const isRendering = status === 'rendering';
  const isDone = status === 'done';
  const isError = status === 'error';
  const canRender = !isRendering && !!onStartRender;
  const statusColor = STATUS_COLOR[status];
  const statusLabel = STATUS_LABEL[status];
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress ?? 0)));

  return (
    <div
      aria-label="Render dock"
      role="region"
      className="fixed inset-x-0 bottom-0 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
      style={{
        background: 'rgba(15,15,17,0.92)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(8px)',
        zIndex: 40,
        // QA fix: when many batch buttons + render CTA combine to
        // exceed the viewport width, flex-wrap pushes the trailing
        // group to a second row. `maxWidth: 100vw` + `boxSizing:
        // border-box` keeps the dock anchored to the viewport
        // regardless of the document's horizontal scroll width.
        maxWidth: '100vw',
        boxSizing: 'border-box',
      }}
    >
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={{ background: statusColor.bg, color: statusColor.fg }}
        >
          {statusLabel}
        </span>
        <span
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={COUNTER_PILL_STYLE}
          title={`${pluralize(imageStats.total, 'row')} total, ${imageStats.ready} with a ready image`}
        >
          Images {imageStats.ready}/{imageStats.total}
        </span>
        {imageStats.failed > 0 && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={FAILED_PILL_STYLE}
            title="Rows whose image generation last failed"
          >
            {imageStats.failed} image{imageStats.failed === 1 ? '' : 's'} failed
          </span>
        )}
        <span
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={COUNTER_PILL_STYLE}
          title={`${pluralize(videoStats.total, 'row')} total, ${videoStats.ready} with a ready clip`}
        >
          Videos {videoStats.ready}/{videoStats.total}
        </span>
        {videoStats.failed > 0 && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={FAILED_PILL_STYLE}
            title="Rows whose B-roll generation last failed"
          >
            {videoStats.failed} clip{videoStats.failed === 1 ? '' : 's'} failed
          </span>
        )}
      </div>

      {isRendering && (
        <div
          className="flex-1 min-w-[160px] flex items-center gap-2"
          aria-live="polite"
        >
          <div
            className="h-1 flex-1 rounded overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            <div
              className="h-full"
              style={{
                width: `${clampedProgress}%`,
                background: 'var(--accent-purple-bright, #a78bfa)',
                transition: 'width 240ms ease-out',
              }}
              role="progressbar"
              aria-valuenow={clampedProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Render progress"
            />
          </div>
          <span
            className="text-[11px] font-mono shrink-0"
            style={{ color: 'var(--text-muted)' }}
          >
            {clampedProgress}%
          </span>
        </div>
      )}

      {isError && errorMessage && (
        <span
          role="status"
          aria-live="assertive"
          className="text-[11px]"
          style={{ color: '#f87171' }}
          title={errorMessage}
        >
          {errorMessage.length > 60 ? `${errorMessage.slice(0, 60)}…` : errorMessage}
        </span>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {imageScopeCounts && onGenerateImagesByScope && (
          <div className="relative" ref={scopeMenuRef}>
            <button
              type="button"
              onClick={() => {
                const next = !scopeMenuOpen;
                if (next) console.info('[prodoc image-scope] dropdown-open', { counts: imageScopeCounts });
                setScopeMenuOpen(next);
              }}
              disabled={!!batchInFlight}
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
              style={{
                ...COUNTER_PILL_STYLE,
                cursor: batchInFlight ? 'not-allowed' : 'pointer',
                opacity: batchInFlight ? 0.5 : 1,
              }}
              title="Generate images for a subset of rows"
            >
              {batchInFlight?.kind === 'image-scope'
                ? `Generating ${batchInFlight.done}/${batchInFlight.total}…`
                : '✨ Generate images ▾'}
            </button>
            {scopeMenuOpen && (
              <div
                role="menu"
                aria-label="Scoped image generation"
                className="absolute right-0 rounded shadow-lg"
                style={{
                  bottom: 'calc(100% + 6px)',
                  background: 'rgba(20,20,24,0.98)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(8px)',
                  minWidth: 260,
                  zIndex: 50,
                  padding: '4px 0',
                }}
              >
                {stateScopes.map((scope) => {
                  const count = imageScopeCounts[scope] ?? 0;
                  const disabled = count === 0;
                  return (
                    <button
                      key={scope}
                      type="button"
                      role="menuitem"
                      disabled={disabled}
                      onClick={() => handleScopeClick(scope, count)}
                      className="w-full text-left text-xs px-3 py-1.5 flex justify-between items-center"
                      style={{
                        background: 'transparent',
                        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        border: 'none',
                      }}
                      onMouseEnter={(e) => {
                        if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>{scopeLabel(scope)}</span>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        ({count})
                      </span>
                    </button>
                  );
                })}
                <div
                  role="separator"
                  style={{
                    height: 1,
                    margin: '4px 0',
                    background: 'rgba(255,255,255,0.08)',
                  }}
                />
                {typeScopes.map((scope) => {
                  const count = imageScopeCounts[scope] ?? 0;
                  const disabled = count === 0;
                  return (
                    <button
                      key={scope}
                      type="button"
                      role="menuitem"
                      disabled={disabled}
                      onClick={() => handleScopeClick(scope, count)}
                      className="w-full text-left text-xs px-3 py-1.5 flex justify-between items-center"
                      style={{
                        background: 'transparent',
                        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        border: 'none',
                      }}
                      onMouseEnter={(e) => {
                        if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>{scopeLabel(scope)}</span>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        ({count})
                      </span>
                    </button>
                  );
                })}
                <div
                  role="separator"
                  style={{
                    height: 1,
                    margin: '4px 0',
                    background: 'rgba(255,255,255,0.08)',
                  }}
                />
                {(() => {
                  const count = imageScopeCounts.all ?? 0;
                  const disabled = count === 0;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={disabled}
                      onClick={() => handleScopeClick('all', count)}
                      className="w-full text-left text-xs px-3 py-1.5 flex justify-between items-center"
                      style={{
                        background: 'transparent',
                        color: disabled ? 'var(--text-muted)' : '#f87171',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        border: 'none',
                        fontWeight: 600,
                      }}
                      onMouseEnter={(e) => {
                        if (!disabled) e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>⚠ {scopeLabel('all')}</span>
                      <span style={{ fontFamily: 'monospace' }}>
                        ({count})
                      </span>
                    </button>
                  );
                })()}
              </div>
            )}
          </div>
        )}
        {onRetryFailedImages && imageStats.failed > 0 && (
          <button
            type="button"
            onClick={onRetryFailedImages}
            disabled={!!batchInFlight}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              ...COUNTER_PILL_STYLE,
              cursor: batchInFlight ? 'not-allowed' : 'pointer',
              opacity: batchInFlight ? 0.5 : 1,
            }}
            title={`Retry the ${imageStats.failed} failed image${imageStats.failed === 1 ? '' : 's'}.`}
          >
            {batchInFlight?.kind === 'retry-images'
              ? `Retrying ${batchInFlight.done}/${batchInFlight.total}…`
              : `↻ Retry images (${imageStats.failed})`}
          </button>
        )}
        {onRetryFailedVideos && videoStats.failed > 0 && (
          <button
            type="button"
            onClick={onRetryFailedVideos}
            disabled={!!batchInFlight}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              ...COUNTER_PILL_STYLE,
              cursor: batchInFlight ? 'not-allowed' : 'pointer',
              opacity: batchInFlight ? 0.5 : 1,
            }}
            title={`Retry the ${videoStats.failed} failed clip${videoStats.failed === 1 ? '' : 's'}.`}
          >
            {batchInFlight?.kind === 'retry-videos'
              ? `Retrying ${batchInFlight.done}/${batchInFlight.total}…`
              : `↻ Retry clips (${videoStats.failed})`}
          </button>
        )}
        {onAnimateAll && (
          <button
            type="button"
            onClick={onAnimateAll}
            disabled={!!batchInFlight}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              ...COUNTER_PILL_STYLE,
              cursor: batchInFlight ? 'not-allowed' : 'pointer',
              opacity: batchInFlight ? 0.5 : 1,
            }}
            title="Generate B-roll clips for every row that doesn't have one yet."
          >
            {batchInFlight?.kind === 'animate'
              ? `Animating ${batchInFlight.done}/${batchInFlight.total}…`
              : '▶ Animate all'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 ms-auto flex-wrap" style={{ marginInlineStart: 'auto' }}>
        {isDone && downloadUrl && (
          <a
            href={downloadUrl}
            download
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              background: 'rgba(16,185,129,0.15)',
              color: '#34d399',
              border: '1px solid rgba(16,185,129,0.30)',
              textDecoration: 'none',
            }}
            title="Download the rendered MP4"
          >
            ⬇ Download
          </a>
        )}
        {onStartRender && (
          <button
            type="button"
            onClick={onStartRender}
            disabled={!canRender}
            className="text-xs px-4 py-1.5 rounded whitespace-nowrap"
            style={{
              ...PRIMARY_BUTTON_STYLE,
              opacity: canRender ? 1 : 0.5,
              cursor: canRender ? 'pointer' : 'not-allowed',
            }}
            title={
              isRendering
                ? 'Render is already in flight'
                : isDone
                  ? 'Start a new render'
                  : 'Start the render'
            }
          >
            {isRendering ? 'Rendering…' : isDone ? '↻ Render again' : 'Start Render →'}
          </button>
        )}
      </div>
    </div>
  );
};
