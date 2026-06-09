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
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BASE_T2I_MODELS, DEFAULT_BASE_T2I_MODEL_ID, type ShortsBaseT2iModelId } from '@/lib/shorts-base-t2i-types';
import type { ShortsBatchWithShorts, BatchTickResult } from '@/lib/shorts-batches-types';
import type { ShortRow, GenerationProgressState, ShortSeoResult } from '@/lib/shorts-types';

interface Props {
  batchId: string;
  onDone: () => void;
}

const POLL_MS = 4_000;
const TIMER_MS = 1_000;

export function Step3Progress({ batchId, onDone }: Props) {
  const router = useRouter();
  const [bundle, setBundle] = useState<ShortsBatchWithShorts | null>(null);
  const [lastTick, setLastTick] = useState<BatchTickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const tickInFlightRef = useRef(false);

  const cancelBatch = useCallback(async () => {
    if (cancelling) return;
    if (!confirm('Cancel this batch? In-progress shorts will be marked as failed.')) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/shorts/batches/${batchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast.success('Batch cancelled');
      router.push('/shorts/batch');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  }, [batchId, cancelling, router]);

  const [kicking, setKicking] = useState(false);
  const kickAssets = useCallback(async () => {
    if (kicking) return;
    setKicking(true);
    try {
      const res = await fetch(`/api/shorts/batches/${batchId}/kick-assets`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        stuck_count: number;
        drain: { ran: boolean; reason?: string } | Record<string, unknown>;
      };
      const ran = (data.drain as { ran?: boolean }).ran;
      toast.success(
        ran
          ? `Kicked the asset drain — ${data.stuck_count} stuck shorts will start processing now.`
          : `Drain is busy (something is already running). Stuck count: ${data.stuck_count}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Kick failed');
    } finally {
      setKicking(false);
    }
  }, [batchId, kicking]);

  const cancelShort = useCallback(
    async (shortId: string) => {
      if (!confirm('Cancel this short? It will be skipped from the rest of the pipeline.')) return;
      try {
        const res = await fetch(`/api/shorts/${shortId}/cancel`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        toast.success('Short cancelled');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Cancel failed');
      }
    },
    [],
  );

  /** Re-queue a failed short. Clears generation_progress so the
   *  orchestrator picks it back up on the next tick from whatever
   *  stage it can derive from observable columns. */
  const retryShort = useCallback(
    async (shortId: string) => {
      try {
        const res = await fetch(`/api/shorts/${shortId}/retry`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          // 429 = cooldown debouncer per QA B5. Surface as info, not
          // error — it's an expected guardrail, not a failure.
          if (res.status === 429) {
            toast.info(body.error || 'Please wait before retrying');
            return;
          }
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        toast.success('Retry queued — the next tick will pick it up');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Retry failed');
      }
    },
    [],
  );

  /** Re-enqueue the short's asset generation with a different base
   *  T2I model. Useful when the current model is slow/erroring and
   *  the user wants to try a different one. POSTs to the existing
   *  /generate-style-assets endpoint with the model override; the
   *  endpoint resets generation_progress to 'queued' for the picked
   *  model.
   *
   *  Per QA finding B3: preserve the short's existing style_id when
   *  re-enqueueing (was hardcoded to `doodle_explainer_2_short`, which
   *  would silently switch a Paint short back to Doodle). Falls back
   *  to the doodle default only when the row has no style yet. */
  const retryAssetsWithModel = useCallback(
    async (shortId: string, modelId: ShortsBaseT2iModelId, currentStyleId: string | null) => {
      try {
        const res = await fetch(`/api/shorts/${shortId}/generate-style-assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            style_id: currentStyleId ?? 'doodle_explainer_2_short',
            shorts_base_t2i_model_id: modelId,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const rawMsg: string = body.error || `HTTP ${res.status}`;
          // Surface the most common 422 (script too short) with an
          // actionable hint instead of raw error text.
          if (res.status === 422 && /short_script|length|too short|30 chars/i.test(rawMsg)) {
            throw new Error(`Script is too short for asset generation (needs at least 30 chars). Re-run extract first.`);
          }
          throw new Error(rawMsg);
        }
        toast.success(`Re-queued with ${modelId}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Retry failed');
      }
    },
    [],
  );

  const fetchBundle = useCallback(async () => {
    const res = await fetch(`/api/shorts/batches/${batchId}`);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    return (await res.json()) as ShortsBatchWithShorts;
  }, [batchId]);

  // Per QA M8: surface non-OK run-tick responses so a broken cron
  // doesn't look like silence. `tickError` is rendered in the strip
  // alongside the last-tick success line.
  const [tickError, setTickError] = useState<string | null>(null);
  const runTick = useCallback(async () => {
    if (tickInFlightRef.current) return;
    tickInFlightRef.current = true;
    try {
      const res = await fetch(`/api/shorts/batches/${batchId}/run-tick`, { method: 'POST' });
      if (res.ok) {
        const result = (await res.json()) as BatchTickResult;
        setLastTick(result);
        setTickError(null);
      } else {
        const body = await res.json().catch(() => ({}));
        setTickError(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setTickError(err instanceof Error ? err.message : 'Tick failed');
    } finally {
      tickInFlightRef.current = false;
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;

    // Per QA H8/M9: stop polling + ticking once the batch reaches a
    // terminal state. Without this the loops kept firing forever
    // pointlessly even after the user navigated.
    const isTerminalStatus = (s: string) =>
      s === 'review' || s === 'done' || s === 'failed';

    // Per QA: also pause when the tab is hidden so a backgrounded tab
    // doesn't DDoS the orchestrator during a long Kie outage.
    const shouldRun = () => !cancelled && (typeof document === 'undefined' || !document.hidden);

    // Two independent loops:
    //   - fetchLoop runs every POLL_MS — cheap, refreshes the UI.
    //     Never waits for a tick to finish.
    //   - tickLoop also runs every POLL_MS but goes through runTick's
    //     in-flight guard, so a held-open tick (the orchestrator's
    //     SEO stage awaits the asset drain, which can take a few
    //     minutes) doesn't queue overlapping ticks — the next tick
    //     just no-ops until the previous one releases. The UI keeps
    //     refreshing throughout via fetchLoop.
    const refresh = async () => {
      try {
        const next = await fetchBundle();
        if (cancelled) return;
        setBundle(next);
        if (isTerminalStatus(next.batch.status)) {
          // Stop both loops; the cleanup clearIntervals will fire on
          // unmount, but signal early-stop via the cancelled flag.
          if (next.batch.status === 'review' || next.batch.status === 'done') {
            onDone();
          }
          cancelled = true;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    };

    void refresh();
    void runTick();

    const fetchId = setInterval(() => {
      if (!shouldRun()) return;
      void refresh();
    }, POLL_MS);
    const tickId = setInterval(() => {
      if (!shouldRun()) return;
      void runTick();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(fetchId);
      clearInterval(tickId);
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
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-[var(--text-primary)]">
            Generating {totals.planned} shorts
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--text-secondary)]">
              {totals.generated} ready · {totals.failed} failed · {pct}%
            </span>
            <button
              type="button"
              onClick={kickAssets}
              disabled={kicking}
              className="rounded-md border border-[var(--accent-purple-bright)] px-3 py-1 text-xs text-[var(--accent-purple-bright)] hover:bg-[var(--accent-purple)]/10 disabled:cursor-not-allowed disabled:opacity-50"
              title="Manually kick the shorts asset cron — useful when shorts are stuck queued and the production cron isn't running."
            >
              {kicking ? 'Kicking…' : 'Kick asset cron'}
            </button>
            <button
              type="button"
              onClick={cancelBatch}
              disabled={cancelling}
              className="rounded-md border border-red-500/30 px-3 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel batch'}
            </button>
          </div>
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
        {tickError && (
          <p className="mt-1 text-xs text-red-300">
            Tick error: {tickError} <span className="text-[var(--text-muted)]">(will retry on the next poll)</span>
          </p>
        )}
      </div>

      <div className="space-y-2">
        {bundle.shorts.map((s) => (
          <ShortProgressRow
            key={s.id}
            short={s}
            nowMs={now}
            onCancel={cancelShort}
            onRetry={retryShort}
            onRetryAssets={retryAssetsWithModel}
          />
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

function ShortProgressRow({
  short,
  nowMs,
  onCancel,
  onRetry,
  onRetryAssets,
}: {
  short: ShortRow;
  nowMs: number;
  onCancel: (shortId: string) => void;
  onRetry: (shortId: string) => void;
  onRetryAssets: (shortId: string, modelId: ShortsBaseT2iModelId, currentStyleId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stages = deriveStages(short);
  const updatedMs = new Date(short.updated_at).getTime();
  const elapsedMs = Math.max(0, nowMs - updatedMs);
  const isError = stages.some((s) => s.status === 'failed');
  const isReady = stages.every((s) => s.status === 'done');
  const activeStage = stages.find((s) => s.status === 'active');
  // The asset model swap is available when the active stage is Assets
  // (or assets failed) — that's when the user wants to try a different
  // base T2I model. For other stages the retry-model picker isn't
  // meaningful.
  const isStuckOnAssets =
    !isReady && (activeStage?.key === 'assets' || stages.some((s) => s.key === 'assets' && s.status === 'failed'));

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex w-full items-center gap-3 px-4 py-3 text-sm">
        <StatusDot status={isError ? 'failed' : isReady ? 'done' : 'active'} />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-3 text-left"
        >
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
        {isStuckOnAssets && (
          <RetryAssetsPicker
            currentModelId={
              (short.generation_progress?.job?.base_t2i_model_id as ShortsBaseT2iModelId | undefined)
              ?? DEFAULT_BASE_T2I_MODEL_ID
            }
            onPick={(modelId) => onRetryAssets(short.id, modelId, short.style_id)}
          />
        )}
        {isError && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(short.id);
            }}
            className="shrink-0 rounded-md border border-[var(--accent-purple-bright)] px-2 py-1 text-xs text-[var(--accent-purple-bright)] hover:bg-[var(--accent-purple)]/15"
            title="Re-queue this short — the next tick picks it up from where it failed"
          >
            ↻ Retry
          </button>
        )}
        {!isError && !isReady && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel(short.id);
            }}
            className="shrink-0 rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
            title="Cancel this short"
          >
            ✕
          </button>
        )}
      </div>

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
          <RowInspector short={short} stages={stages} elapsedMs={elapsedMs} />
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

/** Expanded per-row content inspector. Renders, in order:
 *  - a prominent error banner (if the short failed)
 *  - one collapsible section per stage with the actual generated
 *    artifact (script body, voiceover player, SEO output, asset
 *    thumbnails, render video)
 *  - the original textual log + asset-job phase detail at the bottom
 *
 *  Sections that have no data yet are skipped — when extract hasn't
 *  finished there's nothing to show under Script, so we don't render
 *  an empty card. */
function RowInspector({
  short,
  stages,
  elapsedMs,
}: {
  short: ShortRow;
  stages: DerivedStage[];
  elapsedMs: number;
}) {
  const gp = (short.generation_progress ?? {}) as GenerationProgressState;
  const isError = gp.phase === 'error';

  return (
    <div className="space-y-3">
      {isError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-red-300">
            Generation error
          </div>
          <div className="whitespace-pre-wrap text-[12px] text-red-200">
            {gp.error_message ?? gp.label ?? 'Unknown error'}
          </div>
          {gp.updated_at && (
            <div className="mt-1 text-[10px] text-red-400/70">
              {formatTime(gp.updated_at)}
            </div>
          )}
        </div>
      )}

      <InspectorSection title="Script" defaultOpen={!short.short_script || isError}>
        <ScriptInspector short={short} />
      </InspectorSection>

      <InspectorSection title="Voiceover" defaultOpen={false}>
        <VoiceoverInspector short={short} />
      </InspectorSection>

      <InspectorSection title="SEO" defaultOpen={false}>
        <SeoInspector seo={short.seo_result} />
      </InspectorSection>

      <InspectorSection title="Assets (frames)" defaultOpen={false}>
        <AssetsInspector short={short} />
      </InspectorSection>

      <InspectorSection title="Render" defaultOpen={false}>
        <RenderInspector short={short} />
      </InspectorSection>

      <div className="border-t border-[var(--border)] pt-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Activity log
        </div>
        <Log short={short} stages={stages} elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}

/** Reusable collapsible <details> wrapper for inspector sections.
 *  Uses native <details> so no extra state plumbing is needed and
 *  the open/close survives re-renders driven by the 4s poll loop. */
function InspectorSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-md border border-[var(--border)] bg-[var(--bg-card)]/60">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <span className="text-[var(--text-muted)] group-open:rotate-90 transition-transform" aria-hidden>▸</span>
        <span>{title}</span>
      </summary>
      <div className="border-t border-[var(--border)] px-3 py-3">
        {children}
      </div>
    </details>
  );
}

function ScriptInspector({ short }: { short: ShortRow }) {
  if (!short.short_script) {
    return <p className="text-[var(--text-muted)]">No script yet.</p>;
  }
  return (
    <div className="space-y-3">
      {short.title && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Title</div>
          <div className="text-[var(--text-primary)]">{short.title}</div>
        </div>
      )}
      {short.hook && (
        <div className="rounded-md border border-[var(--accent-purple-bright)]/40 bg-[var(--accent-purple)]/10 px-3 py-2">
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--accent-purple-bright)]">Hook</div>
          <div className="text-[var(--text-primary)]">{short.hook}</div>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Script body</span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {short.word_count ?? '?'} words
            {short.estimated_duration_seconds ? ` · ~${short.estimated_duration_seconds}s` : ''}
          </span>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-[12px] leading-relaxed text-[var(--text-primary)]">
          {short.short_script}
        </pre>
      </div>
      {short.payoff && (
        <div className="rounded-md border border-[var(--accent-green)]/40 bg-[var(--accent-green)]/10 px-3 py-2">
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--accent-green)]">Payoff</div>
          <div className="text-[var(--text-primary)]">{short.payoff}</div>
        </div>
      )}
    </div>
  );
}

function VoiceoverInspector({ short }: { short: ShortRow }) {
  if (!short.voiceover_audio_url) {
    return <p className="text-[var(--text-muted)]">No voiceover yet.</p>;
  }
  return (
    <div className="space-y-2">
      <audio controls preload="metadata" src={short.voiceover_audio_url} className="w-full" />
      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
        <span>
          {short.voiceover_duration_seconds
            ? `${Math.round(short.voiceover_duration_seconds)}s actual`
            : 'duration not measured'}
          {short.voiceover_voice_id ? ` · voice ${short.voiceover_voice_id}` : ''}
        </span>
        <a
          href={short.voiceover_audio_url}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent-purple-bright)] hover:underline"
        >
          Open ↗
        </a>
      </div>
    </div>
  );
}

function SeoInspector({ seo }: { seo: ShortSeoResult | null }) {
  if (!seo) {
    return <p className="text-[var(--text-muted)]">No SEO output yet.</p>;
  }
  const topTitle = seo.titles?.[0];
  const topDesc = seo.descriptions?.[0];
  const topHashtags = seo.hashtag_sets?.[0];
  return (
    <div className="space-y-3">
      {seo.primary_keyword && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Primary keyword</div>
          <div className="text-[var(--text-primary)]">{seo.primary_keyword}</div>
        </div>
      )}
      {topTitle && (
        <div>
          <div className="mb-0.5 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Top title</span>
            <span className="text-[10px] text-[var(--text-muted)]">score {topTitle.score}</span>
          </div>
          <div className="text-[var(--text-primary)]">{topTitle.text}</div>
        </div>
      )}
      {topDesc && (
        <div>
          <div className="mb-0.5 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Top description</span>
            <span className="text-[10px] text-[var(--text-muted)]">score {topDesc.score}</span>
          </div>
          <pre className="whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-[12px] text-[var(--text-primary)]">
            {topDesc.text}
          </pre>
        </div>
      )}
      {topHashtags && topHashtags.tags.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            Hashtags <span className="opacity-60">(visible in description)</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {topHashtags.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--border)] bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>
      )}
      {seo.tags && seo.tags.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            YouTube tags <span className="opacity-60">(invisible metadata · {seo.tags.length} of 30)</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {seo.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--accent-purple-bright)]/30 bg-[var(--accent-purple)]/10 px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
      {seo.notes && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Notes</div>
          <p className="text-[12px] text-[var(--text-secondary)]">{seo.notes}</p>
        </div>
      )}
    </div>
  );
}

function AssetsInspector({ short }: { short: ShortRow }) {
  const sa = short.style_assets ?? {};
  const block = sa.doodle ?? sa.paint;
  if (!block) {
    return <p className="text-[var(--text-muted)]">No frames yet.</p>;
  }
  const frames: Array<{ url: string; label: string }> = [];
  if (block.base_url) frames.push({ url: block.base_url, label: 'Base' });
  // Defensive iteration per QA H9: legacy / mid-flight rows can have
  // `variants` missing or set to a non-array. The type says required,
  // but the DB carries JSONB so trust nothing at the value boundary.
  const variants = Array.isArray(block.variants) ? block.variants : [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (v?.url) frames.push({ url: v.url, label: `Variant ${i + 1}` });
  }
  if (frames.length === 0) {
    return <p className="text-[var(--text-muted)]">No frames yet.</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      {frames.map((f) => (
        <a
          key={f.url}
          href={f.url}
          target="_blank"
          rel="noreferrer"
          className="group relative block overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]"
          title={`${f.label} — click for full size`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={f.url}
            alt={f.label}
            loading="lazy"
            className="aspect-[9/16] w-full object-cover transition-transform group-hover:scale-[1.02]"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 text-[9.5px] text-white">
            {f.label}
          </div>
        </a>
      ))}
    </div>
  );
}

function RenderInspector({ short }: { short: ShortRow }) {
  if (!short.rendered_video_url) {
    return <p className="text-[var(--text-muted)]">Not rendered yet.</p>;
  }
  return (
    <div className="space-y-2">
      <video
        controls
        preload="metadata"
        src={short.rendered_video_url}
        className="aspect-[9/16] w-48 rounded-md bg-black"
      />
      <a
        href={short.rendered_video_url}
        target="_blank"
        rel="noreferrer"
        className="block text-[10px] text-[var(--accent-purple-bright)] hover:underline"
      >
        Open mp4 ↗
      </a>
    </div>
  );
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
    <div className="space-y-3 font-mono">
      <div className="space-y-1.5">
        {lines.map((l, i) => (
          <div key={i} className="flex items-baseline gap-3">
            <span className="shrink-0 text-[var(--text-muted)]">{formatTime(l.when)}</span>
            <span className={`flex-1 ${l.cls ?? 'text-[var(--text-primary)]'}`}>{l.text}</span>
          </div>
        ))}
      </div>

      <AssetJobDetail gp={gp} />

      <div className="border-t border-[var(--border)] pt-2 text-[var(--text-muted)]">
        Last DB write: {formatElapsed(elapsedMs)}
        {elapsedMs > 5 * 60_000 && (
          <span className="ml-2 text-[var(--accent-yellow)]">
            (no activity in 5+ min — may be stuck behind the asset queue)
          </span>
        )}
      </div>
    </div>
  );
}

/** Detailed dump of the asset pipeline's job state. Shows the model
 *  + vendor + niche the cron is using, plus per-variant retry counts
 *  and any per-variant error messages. Hidden when no job state
 *  exists (i.e. the short hasn't reached the asset stage yet). */
function AssetJobDetail({ gp }: { gp: GenerationProgressState }) {
  if (!gp.phase && !gp.job) return null;
  const job = gp.job;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)]/60 p-2.5 text-[10.5px]">
      <div className="mb-1.5 text-[var(--text-secondary)]">Asset pipeline</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[var(--text-muted)]">
        {gp.phase && (
          <>
            <dt>phase</dt>
            <dd className="text-[var(--text-primary)]">{gp.phase}</dd>
          </>
        )}
        {gp.current !== undefined && gp.total !== undefined && (
          <>
            <dt>variant</dt>
            <dd className="text-[var(--text-primary)]">{gp.current} of {gp.total}</dd>
          </>
        )}
        {gp.style_id && (
          <>
            <dt>style</dt>
            <dd className="text-[var(--text-primary)]">{gp.style_id}</dd>
          </>
        )}
        {gp.started_at && (
          <>
            <dt>started</dt>
            <dd className="text-[var(--text-primary)]">{formatTime(gp.started_at)}</dd>
          </>
        )}
        {gp.updated_at && (
          <>
            <dt>updated</dt>
            <dd className="text-[var(--text-primary)]">{formatTime(gp.updated_at)}</dd>
          </>
        )}
        {job?.niche && (
          <>
            <dt>niche</dt>
            <dd className="text-[var(--text-primary)]">{job.niche}</dd>
          </>
        )}
        {job?.base_t2i_model_id && (
          <>
            <dt>base model</dt>
            <dd className="text-[var(--text-primary)]">{job.base_t2i_model_id}</dd>
          </>
        )}
        {job?.variant_edit_primary && (
          <>
            <dt>variant editor</dt>
            <dd className="text-[var(--text-primary)]">{job.variant_edit_primary}</dd>
          </>
        )}
        {job?.max_variants !== undefined && (
          <>
            <dt>max variants</dt>
            <dd className="text-[var(--text-primary)]">{job.max_variants}</dd>
          </>
        )}
        {job?.cost_usd !== undefined && job.cost_usd > 0 && (
          <>
            <dt>cost so far</dt>
            <dd className="text-[var(--text-primary)]">${job.cost_usd.toFixed(3)}</dd>
          </>
        )}
      </dl>

      {job?.variant_attempts && Object.keys(job.variant_attempts).length > 0 && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <div className="mb-1 text-[var(--text-secondary)]">Variant attempts</div>
          <ul className="space-y-0.5">
            {Object.entries(job.variant_attempts).map(([idx, count]) => (
              <li key={idx} className="text-[var(--text-muted)]">
                variant #{idx}: {count} attempt{count === 1 ? '' : 's'}
                {job.variant_errors?.[idx] && (
                  <span className="ml-2 text-red-300">· {job.variant_errors[idx]}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {gp.error_message && (
        <div className="mt-2 border-t border-[var(--border)] pt-2 text-red-300">
          Error: {gp.error_message}
        </div>
      )}
    </div>
  );
}

/** Small inline picker that lets the user swap the base T2I model
 *  mid-batch — surfaces the 4 registered models with their costs
 *  + hints. Closes on outside click. */
function RetryAssetsPicker({
  currentModelId,
  onPick,
}: {
  currentModelId: ShortsBaseT2iModelId;
  onPick: (modelId: ShortsBaseT2iModelId) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  // Per QA finding M11: track in-flight state so double-clicks don't
  // fire two simultaneous re-enqueue POSTs (which race on the asset
  // cron's single-flight drain and produce a misleading "second toast
  // wins" UX).
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePick = async (modelId: ShortsBaseT2iModelId) => {
    if (picking) return;
    setPicking(true);
    setOpen(false);
    try {
      await onPick(modelId);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={picking}
        className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        title="Retry assets with a different image model"
      >
        {picking ? 'Re-queueing…' : 'Try other model ▾'}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Pick a base image model
          </div>
          {BASE_T2I_MODELS.map((m) => {
            const isCurrent = m.id === currentModelId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handlePick(m.id);
                }}
                disabled={isCurrent || picking}
                className={[
                  'block w-full px-3 py-2 text-left text-xs transition-colors',
                  isCurrent || picking
                    ? 'cursor-not-allowed bg-white/[0.04] text-[var(--text-muted)]'
                    : 'text-[var(--text-primary)] hover:bg-white/[0.05]',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-[var(--text-muted)]">
                    ${m.costUsd.toFixed(3)}/img
                    {isCurrent && ' · current'}
                  </span>
                </div>
                <p className="mt-0.5 text-[var(--text-muted)]">{m.hint}</p>
              </button>
            );
          })}
        </div>
      )}
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
