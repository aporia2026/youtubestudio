'use client';

import React from 'react';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';

/**
 * StudioInspectorOverlay — read-only Overlay tab body in the Studio
 * inspector. Phase R3 PR5 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Shows the row's overlay status, its stock search terms (what the
 * AI is asked to fetch), and a transparent PNG preview when one has
 * been resolved. The richer editing surface — Rethink placement, ✎
 * Edit image, ↶ Undo edit, ↺ Reset to AI placement, Remove, plus the
 * drag-and-drop position editor — lands in a follow-up PR (the
 * editing flow has 4 modals and the right-click context menu that
 * deserve their own scope).
 */
export interface StudioInspectorOverlayProps {
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

export const StudioInspectorOverlay: React.FC<StudioInspectorOverlayProps> = ({
  overlay = null,
  stockTerms,
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

      <p
        className="text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        Rethink / Edit / Undo / Reset / Remove controls land in a follow-up PR. For now, use the row's actions in the grid below.
      </p>
    </div>
  );
};
