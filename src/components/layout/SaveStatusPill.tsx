'use client';

import { useEffect, useState, useRef } from 'react';
import { subscribe, drainNow, getState, type OutboxState } from '@/lib/mutate';

/**
 * Persistent "save status" pill rendered globally by AppLayout.
 *
 * Phase 1.4 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md). Subscribes to the
 * client-side mutate() outbox and surfaces its state so the user
 * has a visible answer to "is my work saved?" at any moment.
 *
 * States rendered (in priority order):
 *
 *   - Failed:    `Couldn't save N` — red, clickable to retry the
 *                drainer. The drainer's dead-entries logic decides
 *                when to give up; this pill is just the surface.
 *   - Saving:    `Saving N…` — cyan with a pulsing dot when the
 *                drainer is mid-loop OR when entries are queued.
 *   - Saved:     `Saved` — green, shown for 2s after the pending
 *                count drops to zero, then hides. Tells the user
 *                "your last action landed."
 *   - Idle:      Invisible. No pending, no failed, no recent save.
 *                Keeps the chrome clean; the user already knows
 *                everything is saved.
 *
 * Why bottom-right vs top-right:
 *   The toast surface (sonner) renders in the top-right corner of
 *   this app — putting the pill there would collide with toasts.
 *   Bottom-right keeps it separate, out of the way of any
 *   click-target above it, and matches the convention most editors
 *   use for sync indicators (Notion, Linear, Figma).
 *
 * Click behavior:
 *   - In Saving or Failed state, clicking triggers `drainNow()` to
 *     attempt the queue immediately (useful when the user knows
 *     their connection just came back). No-op in Saved / Idle.
 */
export function SaveStatusPill() {
  const [state, setState] = useState<OutboxState>(getState);
  const [showSaved, setShowSaved] = useState(false);
  const prevPendingRef = useRef(state.pending);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribe(setState);
    return () => {
      unsub();
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Edge-trigger the "Saved" pulse: when pending falls from >0 to 0
  // AND there are no failed entries, show "Saved" for 2 seconds then
  // hide. Don't pulse when we start at zero (initial mount) — the
  // user didn't just do anything.
  useEffect(() => {
    const wasPending = prevPendingRef.current;
    prevPendingRef.current = state.pending;
    if (wasPending > 0 && state.pending === 0 && state.failed === 0) {
      setShowSaved(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000);
    }
  }, [state.pending, state.failed]);

  // Decide what to render. Failed > Saving > Saved > Idle.
  if (state.failed > 0) {
    return (
      <Pill
        kind="failed"
        label={`Couldn't save ${state.failed}`}
        onClick={() => void drainNow()}
        title="Click to retry. Your work is still in the browser — leaving this tab will lose it."
      />
    );
  }
  if (state.pending > 0 || state.draining) {
    const label = state.pending > 0 ? `Saving ${state.pending}…` : 'Saving…';
    return (
      <Pill
        kind="saving"
        label={label}
        onClick={() => void drainNow()}
        title="Sending changes to the server. You can keep working."
      />
    );
  }
  if (showSaved) {
    return <Pill kind="saved" label="Saved" title="All changes are on the server." />;
  }
  return null;
}

interface PillProps {
  kind: 'saving' | 'saved' | 'failed';
  label: string;
  title: string;
  onClick?: () => void;
}

function Pill({ kind, label, title, onClick }: PillProps) {
  const palette = PALETTE[kind];
  const clickable = onClick !== undefined;
  return (
    <div
      role={clickable ? 'button' : 'status'}
      tabIndex={clickable ? 0 : -1}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      title={title}
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 50,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: palette.background,
        border: `1px solid ${palette.border}`,
        color: palette.text,
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: 0.2,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
        cursor: clickable ? 'pointer' : 'default',
        userSelect: 'none',
        transition: 'background 120ms ease',
      }}
    >
      <Dot kind={kind} color={palette.dot} />
      <span>{label}</span>
    </div>
  );
}

function Dot({ kind, color }: { kind: 'saving' | 'saved' | 'failed'; color: string }) {
  // Use a CSS animation defined inline via `<style>`. The pulse only
  // runs on `saving`; the other states get a static dot. Keeping the
  // animation scoped here means SaveStatusPill stays self-contained
  // (no globals.css edit required to support it).
  return (
    <>
      <style>{`
        @keyframes saveStatusPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.6; }
        }
      `}</style>
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          animation: kind === 'saving' ? 'saveStatusPulse 1.4s ease-in-out infinite' : 'none',
        }}
      />
    </>
  );
}

// Color palette per state. Picks from the app's existing accent
// tokens (see src/app/globals.css) so the pill feels consistent with
// the rest of the chrome instead of looking pasted in from a generic
// component library.
const PALETTE: Record<'saving' | 'saved' | 'failed', { background: string; border: string; text: string; dot: string }> = {
  saving: {
    background: 'rgba(6, 182, 212, 0.12)',  // accent-cyan @ 12%
    border: 'rgba(6, 182, 212, 0.4)',
    text: '#22d3ee',                         // accent-cyan-bright
    dot: '#06b6d4',
  },
  saved: {
    background: 'rgba(16, 185, 129, 0.12)',  // accent-green @ 12%
    border: 'rgba(16, 185, 129, 0.4)',
    text: '#10b981',
    dot: '#10b981',
  },
  failed: {
    background: 'rgba(236, 72, 153, 0.14)',  // accent-pink @ 14%
    border: 'rgba(236, 72, 153, 0.5)',
    text: '#f472b6',
    dot: '#ec4899',
  },
};
