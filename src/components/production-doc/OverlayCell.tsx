"use client";

/**
 * Per-row overlay status cell for the Production Doc table.
 *
 * Renders alongside the row's planned `overlay_stock_terms` and shows the
 * live state of the auto-fetch pipeline (Brave search → background
 * removal → R2). Four states map to four visual treatments:
 *
 *   - undefined / 'idle'  → terms pill alone (fetch hasn't started yet)
 *   - 'loading'           → terms pill + spinner + "fetching"
 *   - 'done'              → terms pill + tiny PNG thumbnail (transparent)
 *   - 'skipped' / 'error' → terms pill + ⚠ + Retry button
 *
 * The parent owns the actual fetch — this cell only displays and offers
 * a retry hook.
 */

import type { RowOverlayState } from './overlay-types';

type Zone =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';

interface Props {
  terms: string;
  zone?: Zone;
  size?: 'small' | 'medium' | 'large';
  state?: RowOverlayState;
  onRetry: () => void;
  /** Open the drag-and-drop position editor for this row. Surfaced only
   *  when the overlay has fetched successfully — there's nothing to
   *  position before then. */
  onOpenPositionEditor?: () => void;
  /** True when the row has a manually-set position. Switches the
   *  button label so the user can tell at a glance whether this row
   *  is using the AI placement or their own. */
  hasManualPosition?: boolean;
}

const ZONE_LABELS: Record<Zone, string> = {
  'top-left': '↖',
  'top-right': '↗',
  'bottom-left': '↙',
  'bottom-right': '↘',
  'center-top': '↑',
  'center-bottom': '↓',
  'left-center': '←',
  'right-center': '→',
};

export function OverlayCell({ terms, zone, size, state, onRetry, onOpenPositionEditor, hasManualPosition }: Props) {
  const status = state?.status ?? 'idle';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
          style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', maxWidth: 140 }}
          title={`Overlay: ${terms}${zone ? ` · ${zone}` : ''}${size ? ` · ${size}` : ''}`}
        >
          <span className="truncate">✦ {terms}</span>
        </span>
        {zone && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-muted)' }}
            title={`Planned zone: ${zone}${size ? `, ${size}` : ''}`}
          >
            {ZONE_LABELS[zone]}
          </span>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ width: 10, height: 10 }} />
          fetching…
        </div>
      )}

      {status === 'done' && state?.url && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            {/* 40x28 thumbnail in a table cell — next/image would require
                configuring the R2 public domain in next.config and adds
                runtime overhead unjustified for a status preview this small. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.url}
              alt={terms}
              style={{
                maxWidth: 40,
                maxHeight: 28,
                objectFit: 'contain',
                background:
                  'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 8px 8px',
                borderRadius: 2,
              }}
              title="Auto-sourced overlay (transparent PNG, will be composited at render)"
            />
            <span className="text-[10px]" style={{ color: '#4ade80' }} title="Overlay ready">
              ✓
            </span>
          </div>
          {onOpenPositionEditor && (
            <button
              type="button"
              onClick={onOpenPositionEditor}
              className="text-[10px] px-1.5 py-0.5 rounded self-start"
              style={{
                background: hasManualPosition ? 'rgba(168,85,247,0.16)' : 'rgba(255,255,255,0.04)',
                color: hasManualPosition ? '#c084fc' : 'var(--text-muted)',
                border: `1px solid ${hasManualPosition ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
              }}
              title={
                hasManualPosition
                  ? 'Open the drag-and-drop editor — position is currently manual'
                  : 'Open the drag-and-drop editor to set a custom position'
              }
            >
              {hasManualPosition ? '✋ Position (manual)' : '✋ Position…'}
            </button>
          )}
        </div>
      )}

      {(status === 'skipped' || status === 'error') && (
        <div className="flex items-center gap-1">
          <span
            className="text-[10px]"
            style={{ color: '#f87171' }}
            title={state?.error || 'Overlay fetch failed'}
          >
            ⚠ {status === 'skipped' ? 'not found' : 'fetch failed'}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
