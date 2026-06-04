'use client';

import React from 'react';
import type { RowImageStateView } from '@/components/production-doc/editor/types';

/**
 * StudioInspectorImage — read-only Image tab body in the Studio
 * inspector. Phase R3 PR4 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Shows the row's current image (or its absence) plus a status pill
 * indicating where in the generation lifecycle the row sits. The
 * full ImageCell — with Generate / Upload / Import URL / Edit / Undo
 * / Re-generate controls — lands in R3 PR4b once the writer bundle
 * (matching today's EditorWriters) is plumbed through the shell.
 *
 * Until then, the read-only view gives the user at-a-glance status
 * + a visible thumbnail without forcing them to scroll the legacy
 * grid for the same information. Per rule 10, no action buttons that
 * do nothing.
 */
export interface StudioInspectorImageProps {
  state?: RowImageStateView | null;
}

const STATUS_LABEL: Record<RowImageStateView['status'], string> = {
  idle: 'No image yet',
  pending: 'Queued',
  loading: 'Generating…',
  uploading: 'Uploading…',
  editing: 'Editing…',
  done: 'Ready',
  error: 'Failed',
  search: 'Searching',
};

const STATUS_COLOR: Record<RowImageStateView['status'], { bg: string; fg: string }> = {
  idle:      { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' },
  pending:   { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  loading:   { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  uploading: { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  editing:   { bg: 'rgba(245,158,11,0.15)',  fg: '#fbbf24' },
  done:      { bg: 'rgba(16,185,129,0.12)',  fg: '#34d399' },
  error:     { bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
  search:    { bg: 'rgba(59,130,246,0.12)',  fg: '#60a5fa' },
};

const SOURCE_LABEL: Record<NonNullable<RowImageStateView['source']>, string> = {
  generated: 'AI generated',
  upload:    'Uploaded',
  url:       'Imported from URL',
  edit:      'Edited',
};

export const StudioInspectorImage: React.FC<StudioInspectorImageProps> = ({
  state = null,
}) => {
  if (!state) {
    return (
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        No image has been generated for this row yet.
      </p>
    );
  }

  const status = state.status;
  const statusLabel = STATUS_LABEL[status];
  const statusColor = STATUS_COLOR[status];
  const sourceLabel = state.source ? SOURCE_LABEL[state.source] : null;
  const hasImage = !!state.imageUrl;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={{ background: statusColor.bg, color: statusColor.fg }}
        >
          {statusLabel}
        </span>
        {sourceLabel && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {sourceLabel}
          </span>
        )}
      </div>

      {hasImage && (
        <div
          className="rounded overflow-hidden"
          style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.06)',
            aspectRatio: '16 / 9',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.imageUrl}
            alt="Generated still for the selected row"
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}

      {status === 'error' && state.error && (
        <div
          className="text-xs px-2.5 py-2 rounded leading-relaxed"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          {state.error}
        </div>
      )}

      <p
        className="text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        Generate / Upload / Edit controls land in R3 PR4b. For now, use the row's actions in the grid below.
      </p>
    </div>
  );
};
