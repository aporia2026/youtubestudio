'use client';

/**
 * Tiny "Synced X ago" pill that surfaces the project sync state.
 *
 * Decision A of `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * The pill lives in the page chrome of both production-doc and the
 * editor. It exists so a lazy user (rule 10) can see at a glance that
 * the connection is alive without reading the console. Not inside the
 * editor surface itself — the user asked for the editor UI to stay
 * as-is, so the pill goes ABOVE / OUTSIDE it.
 *
 * Re-renders once per second when in the `saved` state so "X seconds
 * ago" stays current. All other states are static text.
 *
 * Status mapping:
 *   - idle      → "Synced"        (project loaded, no edits pending)
 *   - pending   → "Saving…"       (debounce timer running)
 *   - saving    → "Saving…"       (PATCH in flight)
 *   - saved     → "Synced Xs ago" (PATCH committed)
 *   - error     → "Save failed"   (with tooltip = message)
 *   - conflict  → "Resolving…"    (Phase 3 auto-rebase fires for this;
 *                                  the pill shows the transient state
 *                                  until the rebase completes)
 */
import { useEffect, useRef, useState } from 'react';

export type SyncPillStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

export interface SyncPillProps {
  status: SyncPillStatus;
}

function formatAgo(seconds: number): string {
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function SyncPill({ status }: SyncPillProps): React.JSX.Element {
  // Tick once per second while in `saved` state so "X seconds ago"
  // ticks up without manual refresh. All other states are static.
  //
  // QA fix (2026-06-05): depend on `status.kind === 'saved'` via a
  // ref-based gate so the effect re-mounts only when the kind
  // changes, not when `.at` updates. A parent that recreates `status`
  // on every render with the same kind but a fresher `.at` previously
  // left the interval running against the OLD `.at` reference. The
  // statusRef pattern lets the running interval always read the
  // latest `.at` via the ref, while the effect only re-runs on kind
  // transitions.
  const [, setTick] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    if (status.kind !== 'saved') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status.kind]);

  const visual = (() => {
    switch (status.kind) {
      case 'idle':
        return { label: 'Synced', tone: 'ok' as const, title: 'Project is in sync with the server.' };
      case 'pending':
        return { label: 'Saving…', tone: 'busy' as const, title: 'A save is queued.' };
      case 'saving':
        return { label: 'Saving…', tone: 'busy' as const, title: 'Saving to the server.' };
      case 'saved': {
        // Read via the ref so the interval's re-renders pick up a
        // fresher `.at` from the parent even when the kind hasn't
        // changed. The `status` closure here would otherwise be the
        // one captured at the last useState commit.
        const current = statusRef.current;
        const at = current.kind === 'saved' ? current.at : status.at;
        const ageSec = Math.max(0, (Date.now() - at) / 1000);
        return {
          label: `Synced ${formatAgo(ageSec)}`,
          tone: 'ok' as const,
          title: 'Last successful save.',
        };
      }
      case 'conflict':
        return {
          label: 'Resolving…',
          tone: 'busy' as const,
          title: 'A change from another tab was detected. Merging your edits on top.',
        };
      case 'error':
        return {
          label: 'Save failed',
          tone: 'error' as const,
          title: status.message || 'Save failed — see console.',
        };
    }
  })();

  const palette =
    visual.tone === 'ok'
      ? { bg: 'rgba(16,185,129,0.12)', fg: '#10b981', dot: '#10b981' }
      : visual.tone === 'busy'
        ? { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b', dot: '#f59e0b' }
        : { bg: 'rgba(239,68,68,0.12)', fg: '#ef4444', dot: '#ef4444' };

  return (
    <div
      role="status"
      aria-live="polite"
      title={visual.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        lineHeight: 1.2,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: palette.dot,
          // Subtle pulse on busy states so a lazy user notices motion
          // without having to read the label.
          animation: visual.tone === 'busy' ? 'syncPillPulse 1.2s ease-in-out infinite' : undefined,
        }}
      />
      <span>{visual.label}</span>
      <style>{`
        @keyframes syncPillPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}
