'use client';

import React from 'react';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';

/**
 * StudioInspectorOverlay — Overlay tab body in the Studio inspector.
 * See `_plans/2026-06-04-production-doc-redesign.md` §3.4.
 *
 * R3 PR5 shipped this read-only. R3 Overlay-editable (this revision)
 * adds the action-callback bundle. When any callback is wired the
 * corresponding button renders:
 *
 *   onRethink  — re-fetches the overlay (same stock terms, fresh pick)
 *   onEdit     — opens the smart-edit dialog (prompt + brush mask)
 *   onReset    — clears the row's position / size / stretch overrides
 *   onRemove   — clears the overlay from the row entirely
 *
 * Per rule 10 each button hides when its callback is undefined; ✎ Edit
 * and ↺ Reset additionally hide when there's no overlay to act on,
 * and Remove hides when there's nothing on the row to remove.
 *
 * Drag-and-drop placement and the modal dialogs themselves still live
 * in page.tsx — the inspector just opens them. The position editor /
 * edit dialog get their own scope in a follow-up PR if we surface
 * inline placement controls.
 */
export interface StudioInspectorOverlayActions {
  onRethink?: () => void;
  onEdit?: () => void;
  onReset?: () => void;
  onRemove?: () => void;
  /** How many edits the row has stacked in `overlay_edit_history`.
   *  When > 0, the Undo button is rendered with the count. Capped at
   *  3 by the legacy `OVERLAY_EDIT_HISTORY_CAP`. */
  editHistoryDepth?: number;
  /** Pops the most recent overlay edit from history, restoring the
   *  prior URL. */
  onUndoEdit?: () => void;
}

export interface StudioInspectorOverlayProps extends StudioInspectorOverlayActions {
  /** Per-row overlay state from page.tsx (matches the legacy
   *  `OverlayCell` data shape). */
  overlay?: RowOverlayState | null;
  /** Stock search terms the AI uses to fetch the overlay. Comes
   *  straight off the row, separate from the overlay state so the
   *  tab can show "what we're looking for" even before any fetch
   *  has been attempted. */
  stockTerms?: string;
}

const STATUS_LABEL: Record<RowOverlayState['status'], string> = {
  idle: 'Not fetched',
  loading: 'Fetching…',
  done: 'Ready',
  skipped: 'Skipped',
  error: 'Failed',
};

const STATUS_COLOR: Record<RowOverlayState['status'], { bg: string; fg: string }> = {
  idle:    { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' },
  loading: { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  done:    { bg: 'rgba(16,185,129,0.12)',  fg: '#34d399' },
  skipped: { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' },
  error:   { bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
};

const ACTION_BUTTON_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-secondary)',
  border: '1px solid rgba(255,255,255,0.10)',
  cursor: 'pointer',
};
const DESTRUCTIVE_BUTTON_STYLE: React.CSSProperties = {
  background: 'rgba(239,68,68,0.08)',
  color: '#f87171',
  border: '1px solid rgba(239,68,68,0.20)',
  cursor: 'pointer',
};

export const StudioInspectorOverlay: React.FC<StudioInspectorOverlayProps> = ({
  overlay = null,
  stockTerms,
  onRethink,
  onEdit,
  onReset,
  onRemove,
  editHistoryDepth = 0,
  onUndoEdit,
}) => {
  const trimmedTerms = stockTerms?.trim() ?? '';
  const hasTerms = !!trimmedTerms;

  if (!overlay && !hasTerms) {
    return (
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        This row has no overlay configured. Add stock search terms on the Content tab to enable overlay fetching.
      </p>
    );
  }

  const statusLabel = overlay ? STATUS_LABEL[overlay.status] : null;
  const statusColor = overlay ? STATUS_COLOR[overlay.status] : null;
  const hasImage = overlay?.status === 'done' && !!overlay.url;

  return (
    <div className="space-y-3">
      {statusLabel && statusColor && (
        <div>
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{ background: statusColor.bg, color: statusColor.fg }}
          >
            {statusLabel}
          </span>
        </div>
      )}

      {hasTerms && (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider font-semibold mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            Stock search terms
          </div>
          <div
            className="text-xs leading-relaxed"
            style={{ color: 'var(--text-primary)' }}
          >
            {trimmedTerms}
          </div>
        </div>
      )}

      {hasImage && overlay?.url && (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider font-semibold mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            Preview
          </div>
          <div
            className="rounded overflow-hidden flex items-center justify-center p-3"
            style={{
              background:
                'repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
              border: '1px solid rgba(255,255,255,0.06)',
              minHeight: 80,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={overlay.url}
              alt="Overlay image for the selected row"
              className="max-w-full max-h-40 object-contain"
              loading="lazy"
            />
          </div>
        </div>
      )}

      {overlay?.status === 'error' && overlay.error && (
        <div
          className="text-xs px-2.5 py-2 rounded leading-relaxed"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          {overlay.error}
        </div>
      )}

      {(onRethink || onEdit || onReset || onRemove || onUndoEdit) && (
        <div className="flex flex-wrap items-center gap-2">
          {onUndoEdit && editHistoryDepth > 0 && (
            <button
              type="button"
              onClick={onUndoEdit}
              className="text-xs px-3 py-1.5 rounded"
              style={ACTION_BUTTON_STYLE}
              title={`Restore the overlay state from before the most recent AI edit (${editHistoryDepth} undo step${editHistoryDepth === 1 ? '' : 's'} available).`}
            >
              ↶ Undo edit ({editHistoryDepth})
            </button>
          )}
          {onRethink && hasTerms && (
            <button
              type="button"
              onClick={onRethink}
              className="text-xs px-3 py-1.5 rounded"
              style={ACTION_BUTTON_STYLE}
              title="Re-fetch the overlay using the same stock terms — useful if the first pick didn't suit the scene."
            >
              ↻ Rethink
            </button>
          )}
          {onEdit && hasImage && (
            <button
              type="button"
              onClick={onEdit}
              className="text-xs px-3 py-1.5 rounded"
              style={ACTION_BUTTON_STYLE}
              title="Open the smart edit dialog (prompt or brush mask)."
            >
              ✎ Edit
            </button>
          )}
          {onReset && hasImage && (
            <button
              type="button"
              onClick={onReset}
              className="text-xs px-3 py-1.5 rounded"
              style={ACTION_BUTTON_STYLE}
              title="Discard manual position / size tweaks and fall back to the AI's chosen placement."
            >
              ↺ Reset
            </button>
          )}
          {onRemove && (overlay || hasTerms) && (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs px-3 py-1.5 rounded ms-auto"
              style={DESTRUCTIVE_BUTTON_STYLE}
              title="Remove the overlay from this row entirely. Clears stock terms too."
            >
              ✕ Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
};
