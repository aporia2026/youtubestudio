'use client';

import React from 'react';
import type { BrollStatus } from '@/lib/broll-types';

const KNOWN_STATUSES: ReadonlyArray<BrollStatus> = ['pending', 'generating', 'ready', 'failed'];
function isKnownStatus(s: string): s is BrollStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(s);
}

/**
 * StudioInspectorVideo — read-only Video (B-roll) tab body in the
 * Studio inspector. Phase R3 PR4c of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Shows the row's current B-roll clip status, a `<video>` preview
 * when one is ready, and the duration when known. Generate /
 * Re-generate / Undo controls land in a follow-up PR (the B-roll
 * model picker is rich enough to deserve its own scope).
 *
 * The prop shape matches page.tsx's `rowVideoClips[i]` (UI-side
 * camelCase wrapper around B-roll status) so callers can pass it
 * straight through without unwrapping. Page.tsx does not track an
 * error message at this layer — the failed status is rendered
 * without details and the user can re-trigger from the legacy grid.
 */
export interface StudioInspectorVideoClipSlice {
  status: string;
  videoUrl?: string;
  durationSeconds?: number;
}

export interface StudioInspectorVideoProps {
  clip?: StudioInspectorVideoClipSlice | null;
}

const STATUS_LABEL: Record<BrollStatus, string> = {
  pending: 'Queued',
  generating: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_COLOR: Record<BrollStatus, { bg: string; fg: string }> = {
  pending:    { bg: 'rgba(124,58,237,0.15)', fg: '#a78bfa' },
  generating: { bg: 'rgba(124,58,237,0.15)', fg: '#a78bfa' },
  ready:      { bg: 'rgba(16,185,129,0.12)', fg: '#34d399' },
  failed:     { bg: 'rgba(239,68,68,0.15)',  fg: '#f87171' },
};

function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !isFinite(seconds) || seconds <= 0) return null;
  return `${seconds.toFixed(1)}s`;
}

const UNKNOWN_STATUS_COLOR = { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' };

export const StudioInspectorVideo: React.FC<StudioInspectorVideoProps> = ({
  clip = null,
}) => {
  if (!clip) {
    return (
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        No B-roll clip has been generated for this row yet.
      </p>
    );
  }

  const status = clip.status;
  const known = isKnownStatus(status);
  const statusLabel = known ? STATUS_LABEL[status] : status;
  const statusColor = known ? STATUS_COLOR[status] : UNKNOWN_STATUS_COLOR;
  const durationLabel = status === 'ready'
    ? formatDuration(clip.durationSeconds)
    : null;
  const hasVideo = status === 'ready' && !!clip.videoUrl;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={{ background: statusColor.bg, color: statusColor.fg }}
        >
          {statusLabel}
        </span>
        {durationLabel && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {durationLabel}
          </span>
        )}
      </div>

      {hasVideo && clip.videoUrl && (
        <div
          className="rounded overflow-hidden"
          style={{
            background: '#000',
            border: '1px solid rgba(255,255,255,0.06)',
            aspectRatio: '16 / 9',
          }}
        >
          <video
            src={clip.videoUrl}
            controls
            preload="metadata"
            className="w-full h-full"
            aria-label="B-roll clip for the selected row"
          />
        </div>
      )}

      <p
        className="text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        Generate / Re-generate controls land in a follow-up PR. For now, use the row's actions in the grid below.
      </p>
    </div>
  );
};
