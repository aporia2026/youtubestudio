'use client';

/**
 * Inspector → History tab.
 *
 * Chronological log (newest first) of every B-roll animation
 * generation kickoff the editor has fired for this project, read
 * from `/api/edit/[projectId]/generation-events`. Click an entry to
 * jump to that scene. See `_plans/2026-05-23-editor-generation-history-log.md`.
 *
 * Refresh strategy:
 *
 *   - `refreshTick` (parent-controlled) — bumped by `EditorClient`
 *     immediately after a kickoff insert or a terminal PATCH so the
 *     list reflects the latest event without waiting for the poll
 *     interval. This is the responsive path the user sees right
 *     after clicking Generate.
 *
 *   - 5s polling while mounted — covers reconciliation for entries
 *     that were stuck in `generating` from a previous session
 *     (server-side reconciliation on read joins broll_clips to pick
 *     up the real terminal status). Also covers updates from a
 *     second tab.
 *
 * Both fetches share an AbortController so a fast tick → tick
 * sequence doesn't paint stale data on top of fresh data.
 *
 * Render rules:
 *
 *   - Each entry shows scene index + label (first ~40 chars of the
 *     row's visual_description / script_text), relative timestamp
 *     (hover for absolute), model id (Qwen / LTX / etc.), and a
 *     status pill (generating → spinner, ready → green dot, failed
 *     → red dot + error text inline).
 *
 *   - Re-generations show a small "↻" badge so the user can pick
 *     them out of a long log on the same scene.
 *
 *   - Empty state: short copy that says "no generations yet" and
 *     points at the Generate button.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, History, RotateCw } from 'lucide-react';
import type { ProductionDoc } from '@/remotion/utils';
import { listGenerationEvents, type GenerationEvent } from '@/lib/editor/generation-events';

const REFRESH_INTERVAL_MS = 5000;
const SCENE_LABEL_MAX_LEN = 40;

interface GenerationHistoryPanelProps {
  projectId: string;
  rows: ProductionDoc['rows'];
  /** Bumped by the parent after a kickoff insert or terminal PATCH
   *  so the panel refetches without waiting for the 5s tick. */
  refreshTick: number;
  onJumpToScene: (rowIndex: number) => void;
}

export function GenerationHistoryPanel({
  projectId,
  rows,
  refreshTick,
  onJumpToScene,
}: GenerationHistoryPanelProps): React.ReactElement {
  const [events, setEvents] = useState<GenerationEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Force re-render once a second so relative timestamps ("2m ago")
  // advance without a fetch. The 1s tick is cheap when the panel is
  // visible and stops when the panel unmounts.
  const [, setClockTick] = useState(0);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      // Cancel any prior in-flight fetch so a rapid kickoff → poll
      // sequence doesn't paint stale data on top of fresh.
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      try {
        const next = await listGenerationEvents({
          projectId,
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return;
        setEvents(next);
        setError(null);
        console.info('[history panel] fetched', { count: next.length });
      } catch (err) {
        // AbortError is expected on rapid re-fetch; ignore it.
        if (controller.signal.aborted) return;
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[history panel] fetch failed', { detail: msg });
        setError(msg);
      }
    };

    void fetchOnce();
    const handle = setInterval(() => {
      void fetchOnce();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      inFlightRef.current?.abort();
      clearInterval(handle);
    };
  }, [projectId, refreshTick]);

  // Tick the clock once a second so relative timestamps refresh.
  useEffect(() => {
    const handle = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, []);

  if (events === null && error === null) {
    return (
      <div className="p-4 text-xs text-center" style={{ color: 'var(--fg-muted)' }}>
        Loading history…
      </div>
    );
  }

  if (events !== null && events.length === 0 && error === null) {
    return (
      <div className="p-3">
        <div
          className="rounded-md p-4 text-center space-y-3"
          style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
        >
          <History size={20} strokeWidth={1.5} style={{ color: 'var(--fg-muted)', margin: '0 auto' }} />
          <div className="text-xs" style={{ color: 'var(--fg)' }}>
            No generations yet
          </div>
          <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            Click Generate on any scene to start an animation.
            Every kickoff and re-generation lands here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-1">
      {error !== null && (
        <div
          className="rounded-md p-2 text-[11px] mb-1"
          style={{
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            color: '#fca5a5',
          }}
          role="alert"
        >
          Couldn&apos;t refresh history: {error}
        </div>
      )}
      {(events ?? []).map((event) => (
        <GenerationHistoryRow
          key={event.id}
          event={event}
          rowLabel={getSceneLabel(rows, event.rowIndex)}
          rowExists={Boolean(rows[event.rowIndex])}
          onJump={() => {
            console.info('[history panel jump]', {
              eventId: event.id,
              rowIndex: event.rowIndex,
            });
            onJumpToScene(event.rowIndex);
          }}
        />
      ))}
    </div>
  );
}

interface GenerationHistoryRowProps {
  event: GenerationEvent;
  rowLabel: string;
  rowExists: boolean;
  onJump: () => void;
}

function GenerationHistoryRow({
  event,
  rowLabel,
  rowExists,
  onJump,
}: GenerationHistoryRowProps): React.ReactElement {
  const isRegenerate = event.eventType === 'regenerate';
  const absoluteTime = new Date(event.createdAt).toLocaleString();

  return (
    <button
      type="button"
      onClick={onJump}
      disabled={!rowExists}
      className="text-left rounded-md p-2 transition-colors"
      style={{
        background: 'var(--editor-panel)',
        border: '1px solid var(--editor-edge)',
        opacity: rowExists ? 1 : 0.55,
        cursor: rowExists ? 'pointer' : 'not-allowed',
      }}
      title={
        rowExists
          ? `Jump to Scene ${event.rowIndex + 1}`
          : 'Original scene no longer exists in this project'
      }
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={event.status} />
        <span
          className="text-[11px] font-semibold tabular-nums"
          style={{ color: 'var(--fg)' }}
        >
          Scene {event.rowIndex + 1}
        </span>
        {isRegenerate && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
            style={{
              background: 'var(--editor-accent-soft)',
              color: 'var(--editor-accent)',
            }}
            title="Re-generation (overwrote an earlier clip on this scene)"
          >
            <RotateCw size={9} strokeWidth={2.5} />
            Regen
          </span>
        )}
        <span className="flex-1" />
        <span
          className="text-[10px] ed-mono tabular-nums"
          style={{ color: 'var(--fg-muted)' }}
          title={absoluteTime}
        >
          {formatRelativeTime(event.createdAt)}
        </span>
      </div>
      <div
        className="text-[10px] mt-1 line-clamp-2"
        style={{ color: 'var(--fg-muted)' }}
      >
        {rowLabel}
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="text-[9px] ed-mono px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--fg-muted)',
            border: '1px solid var(--editor-edge)',
          }}
        >
          {event.modelId}
        </span>
        {event.status === 'failed' && event.errorMessage && (
          <span
            className="text-[10px] flex-1 truncate"
            style={{ color: '#fca5a5' }}
            title={event.errorMessage}
          >
            {event.errorMessage}
          </span>
        )}
        {event.reconciled && (
          <span
            className="text-[9px] uppercase tracking-wider"
            style={{ color: 'var(--fg-muted)' }}
            title="Status was recovered from broll_clips after the editor lost the in-memory PATCH path (e.g. tab reload mid-generation)."
          >
            reconciled
          </span>
        )}
      </div>
    </button>
  );
}

function StatusIcon({ status }: { status: GenerationEvent['status'] }): React.ReactElement {
  if (status === 'generating') {
    return (
      <Loader2
        size={12}
        strokeWidth={2.5}
        className="animate-spin"
        style={{ color: 'var(--editor-accent)' }}
        aria-label="Generating"
      />
    );
  }
  if (status === 'ready') {
    return (
      <CheckCircle2
        size={12}
        strokeWidth={2.5}
        style={{ color: '#22c55e' }}
        aria-label="Ready"
      />
    );
  }
  return (
    <XCircle
      size={12}
      strokeWidth={2.5}
      style={{ color: '#ef4444' }}
      aria-label="Failed"
    />
  );
}

function getSceneLabel(rows: ProductionDoc['rows'], rowIndex: number): string {
  const row = rows[rowIndex];
  if (!row) return `Scene no longer exists`;
  const source = (row.visual_description ?? row.script_text ?? '').trim();
  if (source.length === 0) return '(no script or visual description)';
  if (source.length <= SCENE_LABEL_MAX_LEN) return source;
  return `${source.slice(0, SCENE_LABEL_MAX_LEN).trimEnd()}…`;
}

/**
 * Compact relative-time formatter. Mirrors the conventions the rest
 * of the app uses without pulling in a date library:
 *   < 5s   → "just now"
 *   < 60s  → "Ns ago"
 *   < 1h   → "Nm ago"
 *   < 24h  → "Nh ago"
 *   < 7d   → "Nd ago"
 *   else   → absolute date (locale-formatted)
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const deltaSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 7) return `${deltaDay}d ago`;
  return new Date(iso).toLocaleDateString();
}
