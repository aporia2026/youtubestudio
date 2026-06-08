'use client';

/**
 * Step 3 — generation progress, per-short.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Polls /api/shorts/batches/[id] every 4 seconds AND POSTs /run-tick
 * on each poll so the orchestrator keeps draining shorts.
 *
 * Visibility: every short renders as a row with a stage timeline
 * (Script → Voiceover → SEO → Assets → Render) so the user can see
 * exactly which stage each short is in. A second-by-second timer
 * shows "30s ago" / "5m ago" so it's obvious when something hangs.
 * Expanding a row reveals a per-stage activity log with absolute
 * timestamps.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShortsBatchWithShorts, BatchTickResult } from '@/lib/shorts-batches-types';
import type { ShortRow, GenerationProgressState } from '@/lib/shorts-types';

interface Props {
  batchId: string;
  onDone: () => void;
}

const POLL_MS = 4_000;
const TIMER_MS = 1_000;

export function Step3Progress({ batchId, onDone }: Props) {
  const [bundle, setBundle] = useState<ShortsBatchWithShorts | null>(null);
  const [lastTick, setLastTick] = useState<BatchTickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const tickInFlightRef = useRef(false);

  const fetchBundle = useCallback(async () => {
    const res = await fetch(`/api/shorts/batches/${batchId}`);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    return (await res.json()) as ShortsBatchWithShorts;
  }, [batchId]);

  const runTick = useCallback(async () => {
    if (tickInFlightRef.current) return;
    tickInFlightRef.current = true;
    try {
      const res = await fetch(`/api/shorts/batches/${batchId}/run-tick`, { method: 'POST' });
      if (res.ok) {
        const result = (await res.json()) as BatchTickResult;
        setLastTick(result);
      }
    } finally {
      tickInFlightRef.current = false;
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    const cycle = async () => {
      try {
        await runTick();
        if (cancelled) return;
        const next = await fetchBundle();
        if (cancelled) return;
        setBundle(next);
        if (next.batch.status === 'review' || next.batch.status === 'done') {
          onDone();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Tick failed');
      }
    };
    void cycle();
    const pollId = setInterval(() => {
      void cycle();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [fetchBundle, runTick, onDone]);

  // Lightweight 1-second tick driving the "X ago" labels — keeps
  // perceived progress moving even between full poll cycles.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TIMER_MS);
    return () => clearInterval(id);
  }, []);

  if (!bundle && !error) {
    return <p className="text-sm text-[var(--text-muted)]">Starting orchestrator…</p>;
  }
  if (error) {
    return <p className="text-sm text-[var(--accent-yellow)]">{error}</p>;
  }
  if (!bundle) return null;

  const totals = bundle.batch.totals;
  const pct = totals.planned
    ? Math.round(((totals.generated + totals.failed) / totals.planned) * 100)
    : 0;

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-[var(--text-primary)]">
            Generating {totals.planned} shorts
          </h2>
          <span className="text-sm text-[var(--text-secondary)]">
            {totals.generated} ready · {totals.failed} failed · {pct}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full bg-[var(--accent-purple)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        {lastTick && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Last orchestrator tick: claimed {lastTick.claimed}, advanced{' '}
            {lastTick.advanced}, failed {lastTick.failed} ({lastTick.duration_ms}ms)
          </p>
        )}
      </div>

      <div className="space-y-2">
        {bundle.shorts.map((s) => (
          <ShortProgressRow key={s.id} short={s} nowMs={now} />
        ))}
      </div>
    </section>
  );
}

// ─── Per-short row ───────────────────────────────────────────────────

type StageKey = 'extract' | 'voiceover' | 'seo' | 'assets' | 'render';
type StageStatus = 'done' | 'active' | 'pending' | 'failed';

interface DerivedStage {
  key: StageKey;
  label: string;
  status: StageStatus;
  detail?: string;
}

function deriveStages(short: ShortRow): DerivedStage[] {
  const gp = (short.generation_progress ?? {}) as GenerationProgressState;
  const isError = gp.phase === 'error';

  const extractDone = !!short.short_script;
  const voiceoverDone = !!short.voiceover_audio_url;
  const seoDone = !!short.seo_result;
  const assetsPhase = gp.phase;
  const assetsActive = assetsPhase && ['queued', 'planning', 'base', 'variant'].includes(assetsPhase);
  const assetsDone =
    assetsPhase === 'done' ||
    !!(short.style_assets && (short.style_assets.doodle ?? short.style_assets.paint));
  const renderDone = !!short.rendered_video_url;

  const stages: Array<{ key: StageKey; label: string; done: boolean; detail?: string }> = [
    {
      key: 'extract',
      label: 'Script',
      done: extractDone,
      detail: extractDone ? `${short.word_count ?? '?'} words` : undefined,
    },
    {
      key: 'voiceover',
      label: 'Voiceover',
      done: voiceoverDone,
      detail:
        voiceoverDone && short.voiceover_duration_seconds
          ? `${Math.round(short.voiceover_duration_seconds)}s audio`
          : undefined,
    },
    {
      key: 'seo',
      label: 'SEO',
      done: seoDone,
      detail: seoDone ? short.seo_result?.primary_keyword : undefined,
    },
    {
      key: 'assets',
      label: 'Assets',
      done: assetsDone,
      detail: (() => {
        if (assetsDone) return 'frames ready';
        if (assetsActive) {
          if (gp.phase === 'variant' && gp.current && gp.total) {
            return `variant ${gp.current}/${gp.total}`;
          }
          return gp.label ?? gp.phase;
        }
        return undefined;
      })(),
    },
    {
      key: 'render',
      label: 'Render',
      done: renderDone,
      detail: renderDone ? 'video ready' : undefined,
    },
  ];

  let activeAssigned = false;
  return stages.map<DerivedStage>((s) => {
    if (isError && !s.done) {
      return { key: s.key, label: s.label, status: 'failed', detail: gp.error_message ?? 'error' };
    }
    if (s.done) return { key: s.key, label: s.label, status: 'done', detail: s.detail };
    if (!activeAssigned) {
      activeAssigned = true;
      return { key: s.key, label: s.label, status: 'active', detail: s.detail };
    }
    return { key: s.key, label: s.label, status: 'pending', detail: s.detail };
  });
}

function ShortProgressRow({ short, nowMs }: { short: ShortRow; nowMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const stages = deriveStages(short);
  const updatedMs = new Date(short.updated_at).getTime();
  const elapsedMs = Math.max(0, nowMs - updatedMs);
  const isError = stages.some((s) => s.status === 'failed');
  const isReady = stages.every((s) => s.status === 'done');
  const activeStage = stages.find((s) => s.status === 'active');

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm"
      >
        <StatusDot status={isError ? 'failed' : isReady ? 'done' : 'active'} />
        <span className="flex-1 truncate text-[var(--text-primary)]">
          {short.title ?? short.hook ?? '(untitled)'}
        </span>
        <span className="hidden text-xs text-[var(--text-muted)] md:inline">
          {isError ? 'Failed' : isReady ? 'Ready' : `Working on ${activeStage?.label}…`}
        </span>
        <ElapsedBadge ms={elapsedMs} active={!isError && !isReady} />
        <span className="text-xs text-[var(--text-muted)]" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      <div className="border-t border-[var(--border)] px-4 py-3">
        <ol className="flex flex-wrap items-center gap-1.5">
          {stages.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <StagePill stage={s} />
              {i < stages.length - 1 && (
                <span className="text-[var(--text-muted)]" aria-hidden>
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-xs">
          <Log short={short} stages={stages} elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: 'done' | 'active' | 'failed' }) {
  const cls =
    status === 'done'
      ? 'bg-[var(--accent-green)]'
      : status === 'failed'
      ? 'bg-red-400'
      : 'bg-[var(--accent-purple-bright)] animate-pulse';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

function StagePill({ stage }: { stage: DerivedStage }) {
  const cls = (() => {
    switch (stage.status) {
      case 'done':
        return 'border-[var(--accent-green)]/40 bg-[var(--accent-green)]/10 text-[var(--accent-green)]';
      case 'active':
        return 'border-[var(--accent-purple-bright)] bg-[var(--accent-purple)]/15 text-[var(--accent-purple-bright)]';
      case 'failed':
        return 'border-red-500/40 bg-red-500/10 text-red-300';
      case 'pending':
      default:
        return 'border-[var(--border)] bg-white/[0.02] text-[var(--text-muted)]';
    }
  })();
  const glyph =
    stage.status === 'done'
      ? '✓'
      : stage.status === 'failed'
      ? '✕'
      : stage.status === 'active'
      ? '⏳'
      : '·';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${cls}`}
      title={stage.detail}
    >
      <span aria-hidden>{glyph}</span>
      <span>{stage.label}</span>
      {stage.detail && stage.status === 'active' && (
        <span className="text-[10px] opacity-80">· {stage.detail}</span>
      )}
    </span>
  );
}

function ElapsedBadge({ ms, active }: { ms: number; active: boolean }) {
  const text = formatElapsed(ms);
  const cls = active
    ? ms > 5 * 60_000
      ? 'text-[var(--accent-yellow)]'
      : 'text-[var(--text-secondary)]'
    : 'text-[var(--text-muted)]';
  return <span className={`shrink-0 text-xs tabular-nums ${cls}`}>{text}</span>;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function Log({
  short,
  stages,
  elapsedMs,
}: {
  short: ShortRow;
  stages: DerivedStage[];
  elapsedMs: number;
}) {
  const gp = (short.generation_progress ?? {}) as GenerationProgressState;
  const lines: Array<{ when: string; text: string; cls?: string }> = [];

  lines.push({ when: short.created_at, text: 'Created' });

  for (const s of stages) {
    if (s.status === 'done') {
      lines.push({
        when: short.updated_at,
        text: `${s.label} complete${s.detail ? ` · ${s.detail}` : ''}`,
        cls: 'text-[var(--accent-green)]',
      });
    } else if (s.status === 'active') {
      lines.push({
        when: short.updated_at,
        text: `${s.label} in progress${s.detail ? ` · ${s.detail}` : ''}`,
        cls: 'text-[var(--accent-purple-bright)]',
      });
    } else if (s.status === 'failed') {
      lines.push({
        when: short.updated_at,
        text: `${s.label} failed${s.detail ? `: ${s.detail}` : ''}`,
        cls: 'text-red-300',
      });
    }
  }

  if (gp.label) {
    lines.push({
      when: gp.updated_at ?? short.updated_at,
      text: gp.label,
      cls: 'text-[var(--text-secondary)]',
    });
  }

  return (
    <div className="space-y-1.5 font-mono">
      {lines.map((l, i) => (
        <div key={i} className="flex items-baseline gap-3">
          <span className="shrink-0 text-[var(--text-muted)]">{formatTime(l.when)}</span>
          <span className={`flex-1 ${l.cls ?? 'text-[var(--text-primary)]'}`}>{l.text}</span>
        </div>
      ))}
      <div className="mt-2 border-t border-[var(--border)] pt-2 text-[var(--text-muted)]">
        Last DB write: {formatElapsed(elapsedMs)}
        {elapsedMs > 5 * 60_000 && (
          <span className="ml-2 text-[var(--accent-yellow)]">
            (no activity in 5+ min — may be stuck on render trigger)
          </span>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso.slice(11, 19);
  }
}
