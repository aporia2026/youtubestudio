'use client';

import { useState } from 'react';
import type { VideoSummary } from './page';

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
  done: 'Done',
  qa_failed_after_max_retries: 'QA failed (max retries)',
  narration_abandoned: 'Narration abandoned',
  production_doc_failed: 'Shot list failed',
  thumbnail_failed: 'Thumbnail failed',
  editor_assignment_failed: 'Editor assignment failed',
  cancelled_by_user: 'Cancelled',
  cost_cap_exceeded: 'Cost cap exceeded',
};

const TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'cancelled_by_user',
  'cost_cap_exceeded',
]);

const FAILED: ReadonlySet<string> = new Set([
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
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
      // Re-fetch detail to show the new state immediately.
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

  return (
    <div
      className={`border rounded-lg ${
        isFailed
          ? 'border-red-200 dark:border-red-950'
          : isOverdue
          ? 'border-amber-200 dark:border-amber-950'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <button
        onClick={toggle}
        className="w-full p-4 text-left flex items-center gap-4"
      >
        <div className="w-8 text-zinc-500 text-sm font-mono shrink-0">#{video.priority}</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{video.idea_title || '(idea pending)'}</div>
          <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-3 flex-wrap">
            <span className={isFailed ? 'text-red-600 dark:text-red-400' : ''}>
              {STAGE_LABEL[video.stage] ?? video.stage}
            </span>
            {video.script_word_count != null && (
              <span>{video.script_word_count} spoken words</span>
            )}
            {video.critic_overall_score != null && (
              <span>QA score: {video.critic_overall_score}/100</span>
            )}
            {video.retry_count > 0 && <span>{video.retry_count} retry/retries</span>}
            <span>${Number(video.cost_usd).toFixed(2)}</span>
          </div>
        </div>
        <span className="text-zinc-400 shrink-0">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-100 dark:border-zinc-900">
          {loadingDetail && !detail ? (
            <div className="py-4 text-sm text-zinc-500">Loading…</div>
          ) : !detail ? null : (
            <div className="py-4 space-y-4">
              {video.failure_message && (
                <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
                  <div className="font-medium">Failure: {video.failure_class}</div>
                  <div className="mt-1 text-xs">{video.failure_message}</div>
                </div>
              )}

              {/* Script gate — inline action panel when awaiting review */}
              {video.stage === 'awaiting_script_gate' && (
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

              {/* Waiting for narration — manual "narration done" trigger */}
              {(video.stage === 'waiting_narration' || video.stage === 'narration_overdue') && (
                <div className="p-3 rounded-md bg-zinc-50 dark:bg-zinc-900 text-sm">
                  <div className="font-medium mb-1">Narration handoff</div>
                  <div className="text-xs text-zinc-500 mb-3">
                    Deadline:{' '}
                    {video.narration_deadline_at
                      ? new Date(video.narration_deadline_at).toLocaleString()
                      : 'none'}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => callAction({ action: 'narration_done' })}
                      disabled={!!busyAction}
                      className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50"
                    >
                      Narration is done → continue
                    </button>
                    <button
                      onClick={() => callAction({ action: 'extend_narration', days: 7 })}
                      disabled={!!busyAction}
                      className="px-3 py-1.5 rounded-md text-xs border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
                    >
                      Extend +7 days
                    </button>
                    <button
                      onClick={() => callAction({ action: 'abandon' })}
                      disabled={!!busyAction}
                      className="px-3 py-1.5 rounded-md text-xs text-red-600 dark:text-red-400 disabled:opacity-50"
                    >
                      Abandon
                    </button>
                  </div>
                </div>
              )}

              {/* Fix list — visible per user's 2026-05-12 requirement */}
              {detail.latestAppliedFixes?.metadata_jsonb?.applied_fixes && (
                <FixListDisplay
                  fixes={detail.latestAppliedFixes.metadata_jsonb.applied_fixes}
                  attemptNumber={detail.latestAppliedFixes.attempt_number}
                />
              )}

              {/* Critic verdict summary when one exists */}
              {detail.video.verdict && (
                <VerdictSummary verdict={detail.video.verdict} />
              )}

              {/* Thumbnail preview */}
              {detail.video.thumbnail_url && (
                <div>
                  <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Generated thumbnail
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={detail.video.thumbnail_url}
                    alt="Generated thumbnail"
                    className="max-w-md rounded-md border border-zinc-200 dark:border-zinc-800"
                  />
                </div>
              )}

              {/* Production doc summary */}
              {detail.latestProductionDoc && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300 font-medium">
                    Shot-by-shot breakdown (JSON)
                  </summary>
                  <pre className="mt-2 p-3 bg-zinc-50 dark:bg-zinc-900 rounded-md text-xs overflow-x-auto max-h-96">
                    {JSON.stringify(detail.latestProductionDoc, null, 2)}
                  </pre>
                </details>
              )}

              {/* Kill anywhere except terminal */}
              {!isTerminal && video.stage !== 'awaiting_script_gate' && (
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-900">
                  <button
                    onClick={() => {
                      if (confirm('Kill this video? It will be marked cancelled and no further work runs.')) {
                        void callAction({ action: 'kill' });
                      }
                    }}
                    disabled={!!busyAction}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  >
                    Kill this video
                  </button>
                </div>
              )}

              {actionError && (
                <div className="p-2 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
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
    return <div className="text-sm text-zinc-500">Script not loaded.</div>;
  }

  const mins = estimatedDurationSeconds ? Math.floor(estimatedDurationSeconds / 60) : 0;
  const secs = estimatedDurationSeconds ? estimatedDurationSeconds % 60 : 0;

  return (
    <div className="rounded-md border border-amber-200 dark:border-amber-950 bg-amber-50/50 dark:bg-amber-950/20 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium text-sm">Script ready — review and decide</div>
          <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
            {scriptWordCount ?? '?'} spoken words ·{' '}
            {estimatedDurationSeconds ? `~${mins}m ${secs}s @ 140 wpm` : ''}
          </div>
        </div>
      </div>
      {ideaTitle && (
        <div className="text-xs text-zinc-500 mb-2">For: {ideaTitle}</div>
      )}
      <div className="max-h-96 overflow-y-auto p-3 rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm whitespace-pre-wrap mb-3">
        {scriptContent}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onKeep}
          disabled={!!busyAction}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50"
        >
          Keep → run AI script review
        </button>
        <button
          onClick={onRegenerate}
          disabled={!!busyAction}
          className="px-3 py-1.5 rounded-md text-xs border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
        >
          Regenerate script
        </button>
        <button
          onClick={() => {
            if (confirm('Kill this video?')) onKill();
          }}
          disabled={!!busyAction}
          className="px-3 py-1.5 rounded-md text-xs text-red-600 dark:text-red-400 disabled:opacity-50"
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
    <details open className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Fixes applied in retry #{attemptNumber - 1} ({fixes.length})
      </summary>
      <div className="mt-3 space-y-2 text-sm">
        {by.high.length > 0 && (
          <FixGroup title="Must fix" colorClass="text-red-700 dark:text-red-400" items={by.high} />
        )}
        {by.medium.length > 0 && (
          <FixGroup title="Should fix" colorClass="text-amber-700 dark:text-amber-400" items={by.medium} />
        )}
        {by.low.length > 0 && (
          <FixGroup title="Nice to fix" colorClass="text-zinc-600 dark:text-zinc-400" items={by.low} />
        )}
      </div>
    </details>
  );
}

function FixGroup({ title, colorClass, items }: { title: string; colorClass: string; items: FlatFix[] }) {
  return (
    <div>
      <div className={`text-xs font-medium uppercase tracking-wide ${colorClass}`}>{title}</div>
      <ul className="mt-1 space-y-1 list-disc pl-5">
        {items.map((f) => (
          <li key={f.id} className="text-sm">
            {f.text}
            {f.scriptLineRef && (
              <span className="block text-xs text-zinc-500 mt-0.5">
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
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">AI script review</div>
      {overall !== null && (
        <div className="text-2xl font-semibold">{overall}<span className="text-sm text-zinc-500">/100</span></div>
      )}
      {summary && <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-2">{summary}</p>}
      {willPerform && <p className="text-xs text-zinc-500 mt-2">Will it perform: {willPerform}</p>}
    </div>
  );
}
