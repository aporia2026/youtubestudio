'use client';

/**
 * Voiceover-alignment status badge for the editor.
 *
 * Mirrors the prod-doc `AlignmentPill` (production-doc/page.tsx:625) so
 * the editor surfaces the same "Synced to voiceover" affordance the
 * user is used to seeing on the doc side. The realignment ITSELF is
 * already happening in the editor — `productionDocToVideoConfig` is
 * called with `alignment: state.voiceoverAlignment` and the renderer's
 * `realignVideoConfig` retimes scene boundaries accordingly. The badge
 * is purely a visibility surface so the user can confirm at a glance
 * that the scenes they see are aligned to the audio they hear.
 *
 * The editor doesn't initiate alignment itself today (prod-doc owns the
 * voiceover regen + alignment fetch flow); so this component is
 * read-only — no "Re-align" button. When that lands as a separate
 * piece of work, extend with an onRealign prop.
 *
 * Status derivation lives in `lib/editor/alignment-status.ts`.
 */

import type { AlignmentBadgeStatus } from '@/lib/editor/alignment-status';

const PALETTE: Record<
  AlignmentBadgeStatus,
  { bg: string; fg: string; dot: string; label: string }
> = {
  idle: { bg: 'transparent', fg: 'transparent', dot: 'transparent', label: '' },
  syncing: {
    bg: 'rgba(59,130,246,0.10)',
    fg: '#60a5fa',
    dot: '#60a5fa',
    label: 'Syncing scenes to voiceover…',
  },
  ready: {
    bg: 'rgba(16,185,129,0.10)',
    fg: '#34d399',
    dot: '#34d399',
    label: 'Synced to voiceover',
  },
  stale: {
    bg: 'rgba(245,158,11,0.12)',
    fg: '#fbbf24',
    dot: '#fbbf24',
    label: 'Re-align needed',
  },
  failed: {
    bg: 'rgba(239,68,68,0.10)',
    fg: '#f87171',
    dot: '#f87171',
    label: 'Alignment failed',
  },
  unsupported: {
    bg: 'rgba(148,163,184,0.10)',
    fg: '#94a3b8',
    dot: '#94a3b8',
    label: 'Alignment unavailable',
  },
};

interface AlignmentBadgeProps {
  status: AlignmentBadgeStatus;
  detail?: string | null;
  /** Compact variant — drops the detail line and shrinks padding. Used
   *  in the header where vertical space is tight. */
  compact?: boolean;
}

export function AlignmentBadge({
  status,
  detail,
  compact = false,
}: AlignmentBadgeProps): React.ReactElement | null {
  if (status === 'idle') return null;
  const p = PALETTE[status];

  return (
    <div
      className={
        compact
          ? 'flex items-center gap-1.5 text-[11px] rounded-md px-2 py-1'
          : 'mt-2 flex items-start gap-2 text-xs rounded-md px-3 py-2'
      }
      style={{ background: p.bg, color: p.fg }}
      role="status"
      aria-live="polite"
    >
      <span className="flex-shrink-0 mt-0.5">
        {status === 'syncing' ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            className="animate-spin"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : status === 'ready' ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.dot }}
            aria-hidden
          />
        )}
      </span>
      <span className="flex-1 leading-snug">
        <span className="font-medium">{p.label}</span>
        {!compact && detail && (
          <span
            className="block opacity-75 mt-0.5"
            style={{ color: 'var(--fg-muted)' }}
          >
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}
