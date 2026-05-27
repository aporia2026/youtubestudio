'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useCallback } from 'react';
import { use as usePromise } from 'react';
import VideoCard from './VideoCard';

interface RunDetail {
  id: string;
  preset_id: string;
  preset_name: string;
  status: 'idea_ranking' | 'running' | 'paused' | 'done' | 'cancelled';
  ideas_count: number;
  estimated_cost_usd: string | null;
  actual_cost_usd: string;
  created_at: string;
  completed_at: string | null;
  script_gate_enabled: boolean;
  qa_min_score: string;
}

export interface VideoSummary {
  id: string;
  priority: number;
  stage: string;
  retry_count: number;
  failure_class: string | null;
  failure_message: string | null;
  cost_usd: string;
  idea_id: string | null;
  idea_title: string | null;
  idea_hook: string | null;
  script_id: string | null;
  script_word_count: number | null;
  critic_panel_id: string | null;
  critic_overall_score: number | null;
  thumbnail_url: string | null;
  editor_assignment_id: string | null;
  narration_deadline_at: string | null;
  /** Per-video script-style override (migration 0094). Wins over the
   *  run preset's script_style_preset_id and production_doc_style_id.
   *  Null = inherit from the preset chain. */
  script_style_preset_override_id: string | null;
  /** Per-video custom-instructions override (migration 0095). Wins over
   *  the run preset's script_rules_jsonb.additionalContext when non-null.
   *  Empty string is a valid "explicit clear" override. */
  script_additional_context_override: string | null;
  updated_at: string;
  /** Non-null when the cron is actively executing this video's stage
   *  handler. The single most truthful "is it working right now" signal. */
  claimed_at: string | null;
  claimed_by_tick: string | null;
}

/** Auto-pipeline cron schedule from vercel.json (`* * * * *` = every
 *  minute). Surfaced in the UI so the user has a realistic mental
 *  model of how often the orchestrator picks up new work. */
const CRON_TICK_SECONDS = 60;
/** How often the detail page re-fetches. Stays in sync with the
 *  setInterval below. */
const POLL_SECONDS = 10;

const TERMINAL_STAGE_KEYS = [
  'done',
  'idea_generation_failed',
  'script_generation_failed',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cancelled_by_user',
  'cost_cap_exceeded',
] as const;
const FAILURE_STAGE_KEYS = [
  'idea_generation_failed',
  'script_generation_failed',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cost_cap_exceeded',
] as const;
const WAITING_STAGE_KEYS = [
  'awaiting_script_gate',
  'waiting_narration',
  'narration_overdue',
] as const;

function categorize(stage: string): 'done' | 'failed' | 'waiting' | 'in_flight' {
  if (stage === 'done') return 'done';
  if ((FAILURE_STAGE_KEYS as readonly string[]).includes(stage)) return 'failed';
  if (stage === 'cancelled_by_user') return 'failed';
  if ((WAITING_STAGE_KEYS as readonly string[]).includes(stage)) return 'waiting';
  if ((TERMINAL_STAGE_KEYS as readonly string[]).includes(stage)) return 'failed';
  return 'in_flight';
}

export default function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = usePromise(params);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankOrder, setRankOrder] = useState<string[]>([]);
  const [committing, setCommitting] = useState(false);
  // Real "is the page alive" signal. Updated on every successful
  // refresh; rendered with a relative "Xs ago" line so the user can
  // tell the polling didn't silently break.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Wall-clock tick used to re-render the relative timestamps every
  // second. Decoupled from the data refresh so the "Xs ago" string
  // animates smoothly even between 10s polls.
  const [, setTickNow] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    console.info('[pipeline detail] refresh_start', { runId });
    try {
      const res = await fetch(`/api/auto-pipeline/runs/${runId}`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) throw new Error('Run not found.');
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setRun(data.run as RunDetail);
      const vids = (data.videos as VideoSummary[]) ?? [];
      setVideos(vids);
      if (data.run?.status === 'idea_ranking') {
        setRankOrder(vids.map((v) => v.id));
      }
      setLastRefreshedAt(Date.now());
      console.info('[pipeline detail] refresh_ok', {
        runId,
        video_count: vids.length,
        claimed_count: vids.filter((v) => v.claimed_at != null).length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load run';
      console.info('[pipeline detail] refresh_error', { runId, error: msg });
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_SECONDS * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  // Independent 1Hz tick so relative timestamps re-render between
  // data polls. Cheap (state set to a counter; React diffs noop on
  // memoized children).
  useEffect(() => {
    const t = setInterval(() => setTickNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-trigger /api/auto-pipeline/tick when the page detects rows
  // that are stuck (active stage, no claim, no movement for the cron
  // tick interval). On a Vercel deployment the platform cron fires
  // every 60s and this is purely a redundant nudge (the cron lock
  // makes it safe). On local dev there is no platform cron, and this
  // auto-tick is what actually drains the queue — otherwise the user
  // has to remember to click "Run cron tick now" repeatedly.
  //
  // 60s cooldown matches the cron cadence; tickInflightRef prevents a
  // re-entrant call while the previous one is still draining.
  const autoTickCooldownRef = useRef(0);
  const tickInflightRef = useRef(false);
  useEffect(() => {
    if (!run || run.status === 'idea_ranking') return;
    if (tickInflightRef.current) return;
    const now = Date.now();
    if (now - autoTickCooldownRef.current < CRON_TICK_SECONDS * 1000) return;
    // "Worth auto-ticking" = at least one row is active-stage, not
    // claimed, and hasn't moved in CRON_TICK_SECONDS. Mirrors the
    // per-card stuck warning so the auto-tick fires exactly when
    // the user would otherwise click manually.
    const someStuck = videos.some((v) => {
      if (v.claimed_at != null) return false;
      if (categorize(v.stage) !== 'in_flight') return false;
      const ageSec = (now - new Date(v.updated_at).getTime()) / 1000;
      return ageSec > CRON_TICK_SECONDS;
    });
    if (!someStuck) return;
    autoTickCooldownRef.current = now;
    tickInflightRef.current = true;
    console.info('[pipeline detail] auto_tick_start', {
      runId,
      stuck_count: videos.filter((v) => v.claimed_at == null && categorize(v.stage) === 'in_flight').length,
    });
    void (async () => {
      try {
        const res = await fetch('/api/auto-pipeline/tick', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        console.info('[pipeline detail] auto_tick_ok', { runId, ...data });
      } catch (err) {
        console.info('[pipeline detail] auto_tick_error', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        tickInflightRef.current = false;
        void refresh();
      }
    })();
  }, [videos, run, runId, refresh]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-5xl text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </div>
    );
  }
  if (error || !run) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-5xl">
        <Link
          href="/pipeline"
          className="text-sm hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          ← All batches
        </Link>
        <div
          className="mt-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error || 'Run not found.'}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/pipeline"
          className="text-sm hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          ← All batches
        </Link>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        {/* Cross-link to the Command Center kanban. Wave 2 made
            /command-center the home; this batch monitor stays as the
            canonical view for one run but the kanban is where the user
            sees all in-flight work across batches. */}
        <Link
          href="/command-center"
          className="text-sm hover:underline"
          style={{ color: 'var(--accent-purple-bright)' }}
          title="View every in-flight video across batches"
        >
          Open in Command Center →
        </Link>
      </div>
      <div className="flex items-baseline justify-between mt-2 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold gradient-text">{run.preset_name}</h1>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          ${Number(run.actual_cost_usd).toFixed(2)}
          {run.estimated_cost_usd && (
            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
              / est ${Number(run.estimated_cost_usd).toFixed(2)}
            </span>
          )}
        </div>
      </div>
      <p className="text-sm mt-1 mb-2" style={{ color: 'var(--text-muted)' }}>
        {run.ideas_count} videos · QA threshold {run.qa_min_score} ·
        Script gate {run.script_gate_enabled ? 'on' : 'off'} · Created{' '}
        {new Date(run.created_at).toLocaleString()}
      </p>
      <div className="mb-3">
        <PresetSwap
          runId={runId}
          currentPresetId={run.preset_id}
          currentPresetName={run.preset_name}
          onSwapped={() => void refresh()}
        />
      </div>

      {run.status !== 'idea_ranking' && (
        <ProgressStrip
          videos={videos}
          lastRefreshedAt={lastRefreshedAt}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          runId={runId}
          onRunAction={() => void refresh()}
        />
      )}

      {run.status === 'idea_ranking' ? (
        <RankView
          videos={videos}
          rankOrder={rankOrder}
          setRankOrder={setRankOrder}
          onCommit={async () => {
            setCommitting(true);
            try {
              const res = await fetch(`/api/auto-pipeline/runs/${runId}/rank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedVideoIds: rankOrder }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
              }
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to commit ranking');
            } finally {
              setCommitting(false);
            }
          }}
          committing={committing}
          pendingIdeas={videos.some((v) => !v.idea_title)}
        />
      ) : (
        <div className="space-y-3">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} onChanged={() => void refresh()} />
          ))}
        </div>
      )}
    </div>
  );
}

function RankView({
  videos,
  rankOrder,
  setRankOrder,
  onCommit,
  committing,
  pendingIdeas,
}: {
  videos: VideoSummary[];
  rankOrder: string[];
  setRankOrder: (v: string[]) => void;
  onCommit: () => Promise<void>;
  committing: boolean;
  pendingIdeas: boolean;
}) {
  const byId = new Map(videos.map((v) => [v.id, v]));
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  function onDragStart(idx: number) {
    setDragIdx(idx);
  }
  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    const next = [...rankOrder];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    setDragIdx(idx);
    setRankOrder(next);
  }
  function onDragEnd() {
    setDragIdx(null);
  }

  if (pendingIdeas) {
    return (
      <div className="glass rounded-xl p-10 text-center" style={{ borderStyle: 'dashed' }}>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Generating ideas… come back in a minute. This page refreshes every 10 seconds.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
        Drag to rank. Order = priority (top runs first). When you&apos;re happy, click{' '}
        <strong>Start the batch</strong> and the pipeline runs unattended.
      </p>
      <ul className="space-y-2 mb-6">
        {rankOrder.map((id, idx) => {
          const v = byId.get(id);
          if (!v) return null;
          const dragging = dragIdx === idx;
          return (
            <li
              key={id}
              draggable
              onDragStart={() => onDragStart(idx)}
              onDragOver={(e) => onDragOver(e, idx)}
              onDragEnd={onDragEnd}
              className="flex items-start gap-3 p-3 rounded-lg cursor-move transition-all"
              style={{
                background: dragging ? 'rgba(124,58,237,0.10)' : 'var(--bg-card)',
                border: `1px solid ${dragging ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
                opacity: dragging ? 0.7 : 1,
              }}
            >
              <div
                className="w-8 shrink-0 text-sm font-mono pt-0.5"
                style={{ color: 'var(--accent-purple-bright)' }}
              >
                #{idx + 1}
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                  {v.idea_title}
                </div>
                {v.idea_hook && (
                  <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                    {v.idea_hook}
                  </div>
                )}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>⋮⋮</div>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <button
          onClick={() => void onCommit()}
          disabled={committing || rankOrder.length === 0}
          className="btn-primary text-sm"
        >
          {committing ? 'Starting…' : 'Start the batch'}
        </button>
      </div>
    </>
  );
}

/**
 * Header strip that surfaces the only honest progress signals we have:
 *   - Done / failed counts are categorical truth (terminal stages).
 *   - In-flight = anything the cron will pick up on its next tick.
 *   - Waiting = anything blocked on a human (script gate, narration).
 *   - "Live now" = videos with claimed_at non-null (the cron has the
 *     row checked out and is running its handler this instant).
 *   - Last refreshed + cron cadence are wall-clock facts, not animation.
 *
 * Intentionally no animation on "in-flight" — a video can sit there
 * for legitimate reasons (waiting for next cron tick, LLM call running)
 * and a perpetual spinner would lie about whether work is happening.
 */
function ProgressStrip({
  videos,
  lastRefreshedAt,
  refreshing,
  onRefresh,
  runId,
  onRunAction,
}: {
  videos: VideoSummary[];
  lastRefreshedAt: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  runId: string;
  onRunAction: () => void;
}) {
  const total = videos.length;
  const counts = { done: 0, in_flight: 0, waiting: 0, failed: 0 };
  for (const v of videos) counts[categorize(v.stage)]++;
  const liveNow = videos.filter((v) => v.claimed_at != null).length;
  const nonTerminal = counts.in_flight + counts.waiting;
  // "Stuck or failed" = anything Retry would meaningfully act on:
  // failures we can reset, plus in-flight rows that haven't moved in
  // >5min (the same threshold the per-video panel uses for the red
  // warning). Counted client-side so the button shows the count.
  const now = Date.now();
  const stuckOrFailed = videos.filter((v) => {
    if (v.stage === 'narration_abandoned') return false; // unretryable
    if (categorize(v.stage) === 'failed') return true;
    const ageSec = Math.floor((now - new Date(v.updated_at).getTime()) / 1000);
    return v.claimed_at == null && categorize(v.stage) === 'in_flight' && ageSec > 5 * 60;
  }).length;

  const refreshedAgo = lastRefreshedAt != null ? formatAgo(lastRefreshedAt) : null;
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  async function postRunAction(action: 'retry_stuck' | 'stop_all', confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBatchBusy(action);
    setBatchMessage(null);
    console.info('[pipeline detail] run_action_start', { runId, action });
    try {
      const res = await fetch(`/api/auto-pipeline/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setBatchMessage(
        action === 'retry_stuck'
          ? `Reset ${data.changed} of ${data.scanned} videos. Triggering cron…`
          : `Stopped ${data.changed} of ${data.scanned} videos.`,
      );
      console.info('[pipeline detail] run_action_ok', { runId, action, ...data });
      // After retry, immediately kick the manual tick so the user
      // doesn't sit around waiting up to 60s for the cron.
      if (action === 'retry_stuck') await triggerTick();
      onRunAction();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Run action failed';
      console.info('[pipeline detail] run_action_error', { runId, action, error: msg });
      setBatchMessage(msg);
    } finally {
      setBatchBusy(null);
    }
  }

  async function triggerTick() {
    setBatchBusy('tick');
    setBatchMessage(null);
    console.info('[pipeline detail] manual_tick_start', { runId });
    try {
      const res = await fetch('/api/auto-pipeline/tick', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.ran === false) {
        setBatchMessage('Cron is already running. Try again in a moment.');
      } else {
        setBatchMessage(
          `Tick complete: advanced ${data.advanced}` +
            (data.drained_to_empty ? ' (queue empty)' : ''),
        );
      }
      console.info('[pipeline detail] manual_tick_ok', { runId, ...data });
      onRunAction();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Tick failed';
      console.info('[pipeline detail] manual_tick_error', { runId, error: msg });
      setBatchMessage(msg);
    } finally {
      setBatchBusy(null);
    }
  }

  return (
    <div
      className="mb-6 rounded-xl p-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      {/* Progress bar — segmented by category, no animation. */}
      <div
        className="h-2 rounded-full overflow-hidden flex"
        style={{ background: 'var(--bg-primary)' }}
      >
        {counts.done > 0 && (
          <div
            style={{ width: `${(counts.done / total) * 100}%`, background: '#10b981' }}
            title={`${counts.done} done`}
          />
        )}
        {counts.in_flight > 0 && (
          <div
            style={{ width: `${(counts.in_flight / total) * 100}%`, background: 'var(--accent-purple-bright)' }}
            title={`${counts.in_flight} in flight`}
          />
        )}
        {counts.waiting > 0 && (
          <div
            style={{ width: `${(counts.waiting / total) * 100}%`, background: '#f59e0b' }}
            title={`${counts.waiting} waiting on you`}
          />
        )}
        {counts.failed > 0 && (
          <div
            style={{ width: `${(counts.failed / total) * 100}%`, background: '#ef4444' }}
            title={`${counts.failed} failed`}
          />
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 flex-wrap text-xs">
        <ProgressChip count={counts.done} label="done" color="#10b981" />
        <ProgressChip count={counts.in_flight} label="in flight" color="var(--accent-purple-bright)" />
        <ProgressChip count={counts.waiting} label="waiting on you" color="#f59e0b" />
        <ProgressChip count={counts.failed} label="failed" color="#ef4444" />
        {liveNow > 0 && (
          <span
            className="px-2 py-0.5 rounded font-medium"
            style={{
              background: 'rgba(16,185,129,0.10)',
              color: '#10b981',
              border: '1px solid rgba(16,185,129,0.35)',
            }}
            title="The orchestrator is actively executing this video's stage handler right now (claimed_at set)."
          >
            ● {liveNow} live now
          </span>
        )}
      </div>

      <div
        className="mt-3 pt-3 flex items-center justify-between flex-wrap gap-2 text-xs"
        style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
      >
        <div>
          {refreshedAgo
            ? <>Last refreshed {refreshedAgo} · auto every {POLL_SECONDS}s · cron tick every {CRON_TICK_SECONDS}s</>
            : <>Waiting for first refresh…</>}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => void triggerTick()}
            disabled={batchBusy !== null}
            className="disabled:opacity-50 px-2 py-0.5 rounded"
            style={
              stuckOrFailed > 0
                ? {
                    background: 'rgba(16,185,129,0.15)',
                    color: '#10b981',
                    border: '1px solid rgba(16,185,129,0.5)',
                    fontWeight: 600,
                  }
                : { color: 'var(--text-secondary)' }
            }
            title="Manually run one cron drain. Useful in local dev (where Vercel cron doesn't fire) and when a row is sitting idle waiting for the next scheduled tick."
          >
            {batchBusy === 'tick' ? 'Ticking…' : '▶ Run cron tick now'}
          </button>
          {stuckOrFailed > 0 && (
            <button
              onClick={() => void postRunAction('retry_stuck')}
              disabled={batchBusy !== null}
              className="hover:underline disabled:opacity-50 font-medium"
              style={{ color: '#fbbf24' }}
              title="Reset every failed video and clear every zombie claim, then trigger a manual cron tick."
            >
              {batchBusy === 'retry_stuck' ? 'Retrying…' : `Retry ${stuckOrFailed} stuck/failed`}
            </button>
          )}
          {nonTerminal > 0 && (
            <button
              onClick={() => void postRunAction('stop_all', `Stop all ${nonTerminal} non-terminal videos in this run?`)}
              disabled={batchBusy !== null}
              className="hover:underline disabled:opacity-50 font-medium"
              style={{ color: '#f87171' }}
              title="Cancel every non-terminal video in this run."
            >
              {batchBusy === 'stop_all' ? 'Stopping…' : `Stop all (${nonTerminal})`}
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing || batchBusy !== null}
            className="hover:underline disabled:opacity-50"
            style={{ color: 'var(--accent-purple-bright)' }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {/*
        Dev-mode hint. Trigger when no video in the run has been claimed
        AND the oldest update is older than 2 cron ticks. We no longer
        require retry_count===0 or cost_usd===0 — the original
        condition would silently disappear after a Retry click even
        when the cron still wasn't running, leaving the user without
        guidance. The auto-tick effect above also fires on this same
        condition, so seeing this banner without progress is a strong
        signal that the manual tick endpoint itself is failing.
      */}
      {(() => {
        const oldestUpdate = videos.reduce<number | null>((acc, v) => {
          const t = new Date(v.updated_at).getTime();
          return acc == null || t < acc ? t : acc;
        }, null);
        const nothingClaimed = videos.every((v) => v.claimed_at == null);
        const nothingAdvanced = videos.every(
          (v) => v.stage === 'queued' || v.stage === 'generating_script',
        );
        const ageMin = oldestUpdate != null ? (Date.now() - oldestUpdate) / 60000 : 0;
        const ageSec = oldestUpdate != null ? (Date.now() - oldestUpdate) / 1000 : 0;
        const cronLikelyDown =
          oldestUpdate != null &&
          ageSec > CRON_TICK_SECONDS * 2 &&
          nothingClaimed &&
          nothingAdvanced;
        if (!cronLikelyDown) return null;
        return (
          <div
            className="mt-3 p-3 rounded text-xs"
            style={{ background: 'rgba(251,191,36,0.10)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.35)' }}
          >
            <div className="font-semibold mb-1">Cron doesn&apos;t appear to be running.</div>
            <p style={{ color: 'var(--text-secondary)' }}>
              No video in this run has been claimed by the cron, and the queue
              has sat untouched for {Math.floor(ageMin)}m. The page is auto-triggering
              a manual tick every {CRON_TICK_SECONDS}s, but if you keep seeing this
              banner after a refresh, either the manual tick is failing (check the
              browser console for <code>[pipeline detail] auto_tick_error</code>) or
              you&apos;re on local dev where Vercel cron doesn&apos;t fire — deploy to
              Vercel for the automatic every-60s schedule.
            </p>
          </div>
        );
      })()}

      {batchMessage && (
        <div
          className="mt-3 p-2 rounded text-xs"
          style={{
            background: batchMessage.toLowerCase().includes('fail') || batchMessage.toLowerCase().includes('error')
              ? 'rgba(239,68,68,0.10)'
              : 'rgba(16,185,129,0.10)',
            color: batchMessage.toLowerCase().includes('fail') || batchMessage.toLowerCase().includes('error')
              ? '#f87171'
              : '#10b981',
          }}
        >
          {batchMessage}
        </div>
      )}
    </div>
  );
}

function ProgressChip({ count, label, color }: { count: number; label: string; color: string }) {
  if (count === 0) return null;
  return (
    <span style={{ color: 'var(--text-secondary)' }}>
      <span className="font-semibold" style={{ color }}>{count}</span>{' '}
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    </span>
  );
}

/** Returns "Just now", "12s ago", "3m ago", "1h ago". Cheap; no deps. */
export function formatAgo(timestamp: number | string): string {
  const t = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 3) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface PresetListRow {
  id: string;
  name: string;
  niche: string | null;
}

/**
 * Run-level preset swap. PATCHes pipeline_runs.preset_id so future
 * stages on every video in the run pick up the new preset's settings
 * on the next cron tick. Already-completed stages don't auto-rerun —
 * the user explicitly re-runs the videos they want redone via the
 * per-video "Re-run from..." dropdown.
 *
 * Default collapsed: shows "Preset: <name> · Change" as a single
 * inline link. Expand to reveal the picker. Keeps the header tidy
 * while making the affordance discoverable.
 */
function PresetSwap({
  runId,
  currentPresetId,
  currentPresetName,
  onSwapped,
}: {
  runId: string;
  currentPresetId: string;
  currentPresetName: string;
  onSwapped: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<PresetListRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>(currentPresetId);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || presets.length > 0) return;
    setLoading(true);
    void fetch('/api/auto-pipeline/presets', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((d) => setPresets((d.presets as PresetListRow[]) ?? []))
      .catch(() => setPresets([]))
      .finally(() => setLoading(false));
  }, [open, presets.length]);

  async function save() {
    if (selectedId === currentPresetId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/auto-pipeline/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset_id: selectedId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setOpen(false);
      onSwapped();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to swap preset');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
        <span>Preset:</span>
        <span style={{ color: 'var(--text-secondary)' }}>{currentPresetName}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="hover:underline"
          style={{ color: 'var(--accent-purple-bright)' }}
          title="Swap this run's preset. Future stages on every video pick up the new settings on the next cron tick. Already-completed stages stay as-is — use per-video Re-run for those."
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg p-3 text-sm"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-baseline justify-between mb-2 gap-2 flex-wrap">
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
          Change preset
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setSelectedId(currentPresetId);
            setErr(null);
          }}
          className="text-xs hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
        Future stages on every video in this run will use the new preset on the next cron tick.
        Already-completed stages stay as they are — use a video&apos;s &ldquo;Re-run from&rdquo; control
        to redo them under the new preset.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={loading || saving}
          className="text-sm px-3 py-1.5 rounded"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 240 }}
        >
          {loading && <option>Loading…</option>}
          {!loading &&
            presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.niche ? ` — ${p.niche}` : ''}
                {p.id === currentPresetId ? ' (current)' : ''}
              </option>
            ))}
        </select>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || loading || selectedId === currentPresetId}
          className="btn-primary text-xs disabled:opacity-60"
          style={{ padding: '6px 12px' }}
        >
          {saving ? 'Swapping…' : 'Apply'}
        </button>
      </div>
      {err && (
        <div className="mt-2 text-xs" style={{ color: '#f87171' }}>
          {err}
        </div>
      )}
    </div>
  );
}
