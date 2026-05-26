'use client';

import { useState } from 'react';
import type { VideoSummary } from './page';
import { formatAgo } from './page';

interface FlatFix {
  id: string;
  severity: 'high' | 'medium' | 'low';
  text: string;
  source?: string;
  scriptLineRef?: string;
}

interface VideoDetailResponse {
  video: VideoSummary & {
    script_content: string | null;
    script_estimated_duration_seconds: number | null;
    idea_description: string | null;
    verdict: Record<string, unknown> | null;
  };
  latestAppliedFixes: {
    attempt_number: number;
    metadata_jsonb: { applied_fixes?: FlatFix[] } | null;
    created_at: string;
  } | null;
  latestProductionDoc: Record<string, unknown> | null;
  latestSeoOutput: {
    seo?: SeoOutput;
    template_applied?: boolean;
    template_id?: string | null;
    model_used?: string;
  } | null;
}

interface SeoOutput {
  titles?: Array<{ title: string; score?: number; character_count?: number; style?: string }>;
  description?: { above_fold?: string; full_description?: string; hashtags?: string[] };
  tags?: Array<{ tag: string; type?: string; relevance?: number }>;
  chapters?: Array<{ timestamp: string; title: string }>;
  seo_analysis?: { primary_keyword?: string; secondary_keywords?: string[] };
}

const STAGE_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  generating_idea: 'Generating idea',
  generating_script: 'Generating script',
  awaiting_script_gate: 'Awaiting your review',
  running_qa: 'Running AI script review',
  qa_retry: 'Regenerating with fixes',
  waiting_narration: 'Waiting for narration',
  narration_overdue: 'Narration overdue',
  narration_complete: 'Narration complete',
  generating_production_doc: 'Generating shot list',
  generating_thumbnail: 'Generating thumbnail',
  assigning_to_editor: 'Assigning to editor',
  generating_seo: 'Generating SEO metadata',
  done: 'Done',
  qa_failed_after_max_retries: 'QA failed (max retries)',
  narration_abandoned: 'Narration abandoned',
  production_doc_failed: 'Shot list failed',
  thumbnail_failed: 'Thumbnail failed',
  editor_assignment_failed: 'Editor assignment failed',
  seo_failed: 'SEO step failed',
  cancelled_by_user: 'Cancelled',
  cost_cap_exceeded: 'Cost cap exceeded',
};

/**
 * Plain-language explanation of what the orchestrator does at each
 * active stage. Shown in the expanded "What's happening now" panel
 * for in-flight videos that have no other artifact to display yet.
 * Honesty matters: every sentence here describes a real call the
 * cron handler makes.
 */
const STAGE_EXPLANATION: Record<string, string> = {
  queued:
    'This video is in the queue. The cron tick (runs every 60s) will claim it and kick off idea generation on its next pass.',
  generating_idea:
    'The orchestrator is calling an LLM to brainstorm an idea (title, hook, description) for this video. Typically takes 10-30 seconds.',
  generating_script:
    'The orchestrator is calling an LLM to write the full script. The result gets persisted with a word count, then the video advances to either the script gate (if enabled) or the AI script review. Typically takes 30s-3min depending on length.',
  running_qa:
    'A panel of critic agents is scoring the script across multiple axes (hook, retention, payoff, etc.). Each critic is a separate LLM call. Typically takes 1-3 minutes.',
  qa_retry:
    'The script scored below the QA threshold. The orchestrator is calling an LLM to apply the critic fixes and produce a revised script, then it re-runs the QA pass.',
  narration_complete:
    'Narration audio has been uploaded. The orchestrator is updating downstream metadata before kicking off the production doc.',
  generating_production_doc:
    'The orchestrator is generating the shot-by-shot production doc (B-roll prompts, on-screen text, timing) from the script. This is the longest stage — typically 2-5 minutes — because it makes per-row LLM calls.',
  generating_thumbnail:
    'The orchestrator is generating thumbnail candidates by calling an image model. Typically takes 30s-2min depending on provider.',
  assigning_to_editor:
    'The orchestrator is creating an editor assignment, attaching the script + production doc + thumbnail, and dispatching a notification to the assigned editor.',
  generating_seo:
    'The orchestrator is calling an LLM to generate YouTube SEO metadata (titles, description, tags, chapters) from the final script.',
};

const TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cancelled_by_user',
  'cost_cap_exceeded',
]);

const FAILED: ReadonlySet<string> = new Set([
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cost_cap_exceeded',
]);

export default function VideoCard({
  video,
  onChanged,
}: {
  video: VideoSummary;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<VideoDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadDetail() {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/auto-pipeline/videos/${video.id}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setDetail(data as VideoDetailResponse);
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !detail) void loadDetail();
      return next;
    });
  }

  async function callAction(body: Record<string, unknown>) {
    setActionError(null);
    setBusyAction(typeof body.action === 'string' ? body.action : 'action');
    try {
      const res = await fetch(`/api/auto-pipeline/videos/${video.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onChanged();
      void loadDetail();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyAction(null);
    }
  }

  const isFailed = FAILED.has(video.stage);
  const isTerminal = TERMINAL.has(video.stage);
  const isOverdue = video.stage === 'narration_overdue';
  const isAwaitingGate = video.stage === 'awaiting_script_gate';
  const isWaiting = video.stage === 'waiting_narration' || isOverdue || isAwaitingGate;
  // "live now" = the orchestrator literally has this row checked out.
  // No animation key — claimed_at is a real DB field that's only set
  // while a stage handler is mid-execution.
  const isLive = video.claimed_at != null;

  const borderColor = isFailed
    ? 'rgba(239,68,68,0.4)'
    : isAwaitingGate
    ? 'var(--accent-purple-bright)'
    : isOverdue
    ? 'var(--accent-yellow)'
    : 'var(--border)';

  return (
    <div
      className="rounded-xl overflow-hidden glass"
      style={{ border: `1px solid ${borderColor}` }}
    >
      <button
        onClick={toggle}
        className="w-full p-4 text-left flex items-center gap-4 cursor-pointer transition-colors"
        style={{ background: expanded ? 'rgba(124,58,237,0.05)' : 'transparent' }}
      >
        <div
          className="w-8 text-sm font-mono shrink-0"
          style={{ color: 'var(--accent-purple-bright)' }}
        >
          #{video.priority}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
            {video.idea_title || '(idea pending)'}
          </div>
          <div className="text-xs mt-1 flex items-center gap-3 flex-wrap">
            <span
              style={{
                color: isFailed ? '#f87171' : isAwaitingGate ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
              }}
            >
              {STAGE_LABEL[video.stage] ?? video.stage}
            </span>
            {isLive && (
              <span
                className="px-1.5 py-0.5 rounded font-semibold"
                style={{
                  background: 'rgba(16,185,129,0.10)',
                  color: '#10b981',
                  border: '1px solid rgba(16,185,129,0.35)',
                }}
                title={`Cron has the row claimed since ${new Date(video.claimed_at!).toLocaleTimeString()}. The stage handler is executing right now.`}
              >
                ● live · {formatAgo(video.claimed_at!)}
              </span>
            )}
            {video.script_word_count != null && (
              <span style={{ color: 'var(--text-muted)' }}>{video.script_word_count} spoken words</span>
            )}
            {video.critic_overall_score != null && (
              <span style={{ color: 'var(--text-muted)' }}>QA score: {video.critic_overall_score}/100</span>
            )}
            {video.retry_count > 0 && (
              <span style={{ color: 'var(--text-muted)' }}>{video.retry_count} retry/retries</span>
            )}
            <span style={{ color: 'var(--text-muted)' }}>${Number(video.cost_usd).toFixed(2)}</span>
            <span style={{ color: 'var(--text-muted)' }} title={`Last stage transition at ${new Date(video.updated_at).toLocaleString()}`}>
              · updated {formatAgo(video.updated_at)}
            </span>
          </div>
        </div>
        <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border)' }}>
          {loadingDetail && !detail ? (
            <div className="py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading…
            </div>
          ) : !detail ? null : (
            <div className="py-4 space-y-4">
              {video.failure_message && (
                <div
                  className="p-3 rounded text-sm"
                  style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
                >
                  <div className="font-semibold">Failure: {video.failure_class}</div>
                  <div className="mt-1 text-xs" style={{ opacity: 0.9 }}>
                    {video.failure_message}
                  </div>
                </div>
              )}

              {!isTerminal && !isWaiting && (
                <ActivityPanel video={video} />
              )}

              {isAwaitingGate && (
                <ScriptGate
                  scriptContent={detail.video.script_content}
                  scriptWordCount={video.script_word_count}
                  estimatedDurationSeconds={detail.video.script_estimated_duration_seconds}
                  ideaTitle={video.idea_title}
                  busyAction={busyAction}
                  onKeep={() => callAction({ action: 'script_gate', decision: 'keep' })}
                  onRegenerate={() => callAction({ action: 'script_gate', decision: 'regenerate' })}
                  onKill={() => callAction({ action: 'script_gate', decision: 'kill' })}
                />
              )}

              {(video.stage === 'waiting_narration' || video.stage === 'narration_overdue') && (
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                  <div className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                    Narration handoff
                  </div>
                  <div className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                    Deadline:{' '}
                    {video.narration_deadline_at
                      ? new Date(video.narration_deadline_at).toLocaleString()
                      : 'none'}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => callAction({ action: 'narration_done' })}
                      disabled={!!busyAction}
                      className="btn-primary text-xs"
                      style={{ padding: '6px 12px' }}
                    >
                      Narration is done → continue
                    </button>
                    <button
                      onClick={() => callAction({ action: 'extend_narration', days: 7 })}
                      disabled={!!busyAction}
                      className="btn-secondary text-xs"
                      style={{ padding: '6px 12px' }}
                    >
                      Extend +7 days
                    </button>
                    <button
                      onClick={() => callAction({ action: 'abandon' })}
                      disabled={!!busyAction}
                      className="btn-danger text-xs"
                      style={{ padding: '6px 12px' }}
                    >
                      Abandon
                    </button>
                  </div>
                </div>
              )}

              {detail.latestAppliedFixes?.metadata_jsonb?.applied_fixes && (
                <FixListDisplay
                  fixes={detail.latestAppliedFixes.metadata_jsonb.applied_fixes}
                  attemptNumber={detail.latestAppliedFixes.attempt_number}
                />
              )}

              {detail.video.verdict && <VerdictSummary verdict={detail.video.verdict} />}

              {detail.video.thumbnail_url && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
                    Generated thumbnail
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={detail.video.thumbnail_url}
                    alt="Generated thumbnail"
                    className="max-w-md rounded-lg"
                    style={{ border: '1px solid var(--border)' }}
                  />
                </div>
              )}

              {detail.latestProductionDoc && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-semibold text-xs uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                    Shot-by-shot breakdown (JSON)
                  </summary>
                  <pre
                    className="mt-2 p-3 rounded text-xs overflow-x-auto"
                    style={{
                      background: 'var(--bg-primary)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                      maxHeight: 384,
                    }}
                  >
                    {JSON.stringify(detail.latestProductionDoc, null, 2)}
                  </pre>
                </details>
              )}

              {detail.latestSeoOutput?.seo && (
                <SeoOutputPanel
                  seo={detail.latestSeoOutput.seo}
                  templateApplied={detail.latestSeoOutput.template_applied === true}
                  modelUsed={detail.latestSeoOutput.model_used ?? null}
                />
              )}

              <CardActions
                video={video}
                busyAction={busyAction}
                onRetry={() => callAction({ action: 'retry' })}
                onStop={() => {
                  if (confirm('Stop this video? It will be marked cancelled and no further work runs.')) {
                    void callAction({ action: 'kill' });
                  }
                }}
              />

              {actionError && (
                <div
                  className="p-2 rounded text-xs"
                  style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
                >
                  {actionError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Bottom-of-card action row. Three real possibilities:
 *
 *   - Retry: visible when the row is in a retry-able terminal failure
 *     OR is stuck (no claim + no movement > 5min). Hidden for
 *     `narration_abandoned` (unretryable via this path) and for healthy
 *     in-flight rows (the cron will pick them up on its next tick;
 *     showing Retry there would lie about what it does).
 *
 *   - Stop: visible whenever the row isn't already terminal and isn't
 *     awaiting human input at the script gate (the script gate has its
 *     own Kill button in the gate panel).
 *
 *   - Nothing: hides the whole strip if neither action applies (e.g.
 *     terminal `done` with nothing to do).
 */
function CardActions({
  video,
  busyAction,
  onRetry,
  onStop,
}: {
  video: VideoSummary;
  busyAction: string | null;
  onRetry: () => void;
  onStop: () => void;
}) {
  const isTerminal = TERMINAL.has(video.stage);
  const isAwaitingGate = video.stage === 'awaiting_script_gate';
  const isUnretryable = video.stage === 'narration_abandoned';
  const sinceUpdateSec = Math.max(
    0,
    Math.floor((Date.now() - new Date(video.updated_at).getTime()) / 1000),
  );
  const isStuck =
    !isTerminal &&
    video.claimed_at == null &&
    sinceUpdateSec > 5 * 60 &&
    video.stage !== 'awaiting_script_gate' &&
    video.stage !== 'waiting_narration' &&
    video.stage !== 'narration_overdue';

  const showRetry = !isUnretryable && (FAILED.has(video.stage) || video.stage === 'cancelled_by_user' || isStuck);
  const showStop = !isTerminal && !isAwaitingGate;

  if (!showRetry && !showStop) return null;

  return (
    <div className="pt-2 flex items-center gap-4" style={{ borderTop: '1px solid var(--border)' }}>
      {showRetry && (
        <button
          onClick={onRetry}
          disabled={!!busyAction}
          className="text-xs hover:underline disabled:opacity-50 font-medium"
          style={{ color: '#fbbf24' }}
          title={
            FAILED.has(video.stage)
              ? 'Reset this video to the stage that retries the failed step, clear the failure metadata, and bump retry_count.'
              : 'Clear the stale claim (if any) so the cron picks this row up on its next tick.'
          }
        >
          Retry
        </button>
      )}
      {showStop && (
        <button
          onClick={onStop}
          disabled={!!busyAction}
          className="text-xs hover:underline disabled:opacity-50"
          style={{ color: '#f87171' }}
        >
          Stop this video
        </button>
      )}
    </div>
  );
}

/**
 * Real-time activity panel for in-flight, non-waiting stages. Shows
 * only what the DB actually says — no fake animations, no fabricated
 * progress, no spinning wheels that lie. The three signals here are
 * concrete:
 *   1. STAGE_EXPLANATION  — what the orchestrator does at this stage.
 *   2. claimed_at         — whether the cron is mid-execution right now.
 *   3. updated_at         — when the last stage transition happened.
 * If `updated_at` is old AND `claimed_at` is null, the panel shows
 * the wait honestly ("waiting for next cron tick"). If it's been
 * many minutes with no movement, the panel says so plainly so the
 * user knows to investigate, not assume things are humming.
 */
function ActivityPanel({ video }: { video: VideoSummary }) {
  const explanation = STAGE_EXPLANATION[video.stage] ?? null;
  const isLive = video.claimed_at != null;
  const updatedMs = new Date(video.updated_at).getTime();
  const sinceUpdateSec = Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));
  // Surface a "looks stuck" warning if the cron hasn't touched the
  // row in > 5 minutes and isn't currently claiming it. 5 min is the
  // 99th-percentile upper bound on any single active stage; beyond
  // that something likely broke (LLM timeout, cron paused, etc.).
  const looksStuck = !isLive && sinceUpdateSec > 5 * 60;

  return (
    <div
      className="rounded-lg p-4"
      style={{
        background: looksStuck ? 'rgba(239,68,68,0.05)' : 'var(--bg-card)',
        border: `1px solid ${looksStuck ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
      }}
    >
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
        What&apos;s happening now
      </div>

      {explanation && (
        <p className="text-sm mb-3" style={{ color: 'var(--text-primary)' }}>
          {explanation}
        </p>
      )}

      <dl className="text-xs grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 gap-x-4">
        <div>
          <dt className="inline" style={{ color: 'var(--text-muted)' }}>Stage: </dt>
          <dd className="inline font-medium" style={{ color: 'var(--text-primary)' }}>{STAGE_LABEL[video.stage] ?? video.stage}</dd>
        </div>
        <div>
          <dt className="inline" style={{ color: 'var(--text-muted)' }}>Last transition: </dt>
          <dd className="inline" style={{ color: 'var(--text-primary)' }}>
            {formatAgo(video.updated_at)}
            <span style={{ color: 'var(--text-muted)' }}> ({new Date(video.updated_at).toLocaleTimeString()})</span>
          </dd>
        </div>
        <div>
          <dt className="inline" style={{ color: 'var(--text-muted)' }}>Cron status: </dt>
          <dd className="inline" style={{ color: isLive ? '#10b981' : 'var(--text-primary)' }}>
            {isLive
              ? <>● Active (claimed {formatAgo(video.claimed_at!)})</>
              : <>○ Idle — next tick within 60s</>}
          </dd>
        </div>
        <div>
          <dt className="inline" style={{ color: 'var(--text-muted)' }}>Retries: </dt>
          <dd className="inline" style={{ color: 'var(--text-primary)' }}>{video.retry_count}</dd>
        </div>
        <div>
          <dt className="inline" style={{ color: 'var(--text-muted)' }}>Cost so far: </dt>
          <dd className="inline" style={{ color: 'var(--text-primary)' }}>${Number(video.cost_usd).toFixed(4)}</dd>
        </div>
      </dl>

      {looksStuck && (
        <div
          className="mt-3 p-2 rounded text-xs"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          No movement in {Math.floor(sinceUpdateSec / 60)}m and the cron isn&apos;t
          currently claiming this row. The orchestrator may have crashed mid-handler
          or the LLM call may be timing out. Check server logs or kill the video and
          retry from a fresh batch.
        </div>
      )}
    </div>
  );
}

function ScriptGate(props: {
  scriptContent: string | null;
  scriptWordCount: number | null;
  estimatedDurationSeconds: number | null;
  ideaTitle: string | null;
  busyAction: string | null;
  onKeep: () => void;
  onRegenerate: () => void;
  onKill: () => void;
}) {
  const {
    scriptContent,
    scriptWordCount,
    estimatedDurationSeconds,
    ideaTitle,
    busyAction,
    onKeep,
    onRegenerate,
    onKill,
  } = props;

  if (!scriptContent) {
    return (
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Script not loaded.
      </div>
    );
  }

  const mins = estimatedDurationSeconds ? Math.floor(estimatedDurationSeconds / 60) : 0;
  const secs = estimatedDurationSeconds ? estimatedDurationSeconds % 60 : 0;

  return (
    <div
      className="rounded-lg p-4"
      style={{
        background: 'rgba(124,58,237,0.08)',
        border: '1px solid var(--accent-purple-bright)',
      }}
    >
      <div className="mb-3">
        <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          Script ready — review and decide
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {scriptWordCount ?? '?'} spoken words ·{' '}
          {estimatedDurationSeconds ? `~${mins}m ${secs}s @ 140 wpm` : ''}
        </div>
      </div>
      {ideaTitle && (
        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          For: {ideaTitle}
        </div>
      )}
      <div
        className="p-3 rounded text-sm whitespace-pre-wrap mb-3"
        style={{
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          maxHeight: 384,
          overflowY: 'auto',
        }}
      >
        {scriptContent}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={onKeep}
          disabled={!!busyAction}
          className="btn-primary text-xs"
          style={{ padding: '8px 14px' }}
        >
          Keep → run AI script review
        </button>
        <button
          onClick={onRegenerate}
          disabled={!!busyAction}
          className="btn-secondary text-xs"
          style={{ padding: '8px 14px' }}
        >
          Regenerate script
        </button>
        <button
          onClick={() => {
            if (confirm('Kill this video?')) onKill();
          }}
          disabled={!!busyAction}
          className="btn-danger text-xs"
          style={{ padding: '8px 14px' }}
        >
          Kill
        </button>
      </div>
    </div>
  );
}

function FixListDisplay({ fixes, attemptNumber }: { fixes: FlatFix[]; attemptNumber: number }) {
  if (!Array.isArray(fixes) || fixes.length === 0) return null;
  const by: Record<FlatFix['severity'], FlatFix[]> = { high: [], medium: [], low: [] };
  for (const f of fixes) by[f.severity].push(f);
  return (
    <details
      open
      className="rounded-lg p-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <summary
        className="cursor-pointer text-sm font-semibold"
        style={{ color: 'var(--text-primary)' }}
      >
        Fixes applied in retry #{attemptNumber - 1} ({fixes.length})
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        {by.high.length > 0 && (
          <FixGroup title="Must fix" color="#f87171" items={by.high} />
        )}
        {by.medium.length > 0 && (
          <FixGroup title="Should fix" color="#fbbf24" items={by.medium} />
        )}
        {by.low.length > 0 && (
          <FixGroup title="Nice to fix" color="var(--text-muted)" items={by.low} />
        )}
      </div>
    </details>
  );
}

function FixGroup({ title, color, items }: { title: string; color: string; items: FlatFix[] }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
        {title}
      </div>
      <ul className="mt-1 space-y-1 list-disc pl-5">
        {items.map((f) => (
          <li key={f.id} className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {f.text}
            {f.scriptLineRef && (
              <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                re: &quot;{f.scriptLineRef}&quot;
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerdictSummary({ verdict }: { verdict: Record<string, unknown> }) {
  const overall = typeof verdict.overall_score === 'number' ? verdict.overall_score : null;
  const summary = typeof verdict.chair_summary === 'string' ? verdict.chair_summary : null;
  const willPerform = typeof verdict.will_it_perform === 'string' ? verdict.will_it_perform : null;
  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
        AI script review
      </div>
      {overall !== null && (
        <div className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {overall}
          <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
            / 100
          </span>
        </div>
      )}
      {summary && (
        <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
          {summary}
        </p>
      )}
      {willPerform && (
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Will it perform: {willPerform}
        </p>
      )}
    </div>
  );
}

function SeoOutputPanel({
  seo,
  templateApplied,
  modelUsed,
}: {
  seo: SeoOutput;
  templateApplied: boolean;
  modelUsed: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const titles = seo.titles ?? [];
  const tags = seo.tags ?? [];
  const chapters = seo.chapters ?? [];

  function copy(label: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          SEO metadata
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {templateApplied ? 'Template applied' : 'No template'}
          {modelUsed && <span className="ml-2">· {modelUsed}</span>}
        </div>
      </div>

      {titles.length > 0 && (
        <details open className="mb-3">
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Title candidates ({titles.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {titles.slice(0, 8).map((t, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm">
                <span
                  className="text-xs font-mono w-6 shrink-0 pt-0.5"
                  style={{ color: 'var(--text-muted)' }}
                >
                  #{idx + 1}
                </span>
                <span className="flex-1" style={{ color: 'var(--text-primary)' }}>{t.title}</span>
                {typeof t.score === 'number' && (
                  <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {t.score}/100
                  </span>
                )}
                <button
                  onClick={() => copy(`title-${idx}`, t.title)}
                  className="text-xs hover:underline shrink-0"
                  style={{ color: 'var(--accent-purple-bright)' }}
                  type="button"
                >
                  {copied === `title-${idx}` ? '✓' : 'copy'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {seo.description?.full_description && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Description
          </summary>
          <div
            className="mt-2 text-sm whitespace-pre-wrap p-3 rounded"
            style={{
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              maxHeight: 256,
              overflowY: 'auto',
            }}
          >
            {seo.description.full_description}
          </div>
          <button
            onClick={() => copy('desc', seo.description!.full_description!)}
            className="mt-2 text-xs hover:underline"
            style={{ color: 'var(--accent-purple-bright)' }}
            type="button"
          >
            {copied === 'desc' ? '✓ copied' : 'copy description'}
          </button>
        </details>
      )}

      {tags.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Tags ({tags.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t, idx) => (
              <span
                key={idx}
                className="text-xs px-2 py-0.5 rounded"
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
                title={t.type ?? undefined}
              >
                {t.tag}
              </span>
            ))}
          </div>
          <button
            onClick={() => copy('tags', tags.map((t) => t.tag).join(', '))}
            className="mt-2 text-xs hover:underline"
            style={{ color: 'var(--accent-purple-bright)' }}
            type="button"
          >
            {copied === 'tags' ? '✓ copied' : 'copy comma-separated'}
          </button>
        </details>
      )}

      {chapters.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Chapters ({chapters.length})
          </summary>
          <ul className="mt-2 space-y-0.5 text-sm font-mono">
            {chapters.map((c, idx) => (
              <li key={idx} style={{ color: 'var(--text-primary)' }}>
                <span style={{ color: 'var(--text-muted)' }}>{c.timestamp}</span> {c.title}
              </li>
            ))}
          </ul>
          <button
            onClick={() => copy('chapters', chapters.map((c) => `${c.timestamp} ${c.title}`).join('\n'))}
            className="mt-2 text-xs hover:underline"
            style={{ color: 'var(--accent-purple-bright)' }}
            type="button"
          >
            {copied === 'chapters' ? '✓ copied' : 'copy as block'}
          </button>
        </details>
      )}
    </div>
  );
}
