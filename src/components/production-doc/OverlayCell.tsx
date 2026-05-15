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

export function OverlayCell({ terms, zone, size, state, onRetry }: Props) {
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
