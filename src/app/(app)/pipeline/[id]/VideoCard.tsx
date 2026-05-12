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

              {!isTerminal && !isAwaitingGate && (
                <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                  <button
                    onClick={() => {
                      if (confirm('Kill this video? It will be marked cancelled and no further work runs.')) {
                        void callAction({ action: 'kill' });
                      }
                    }}
                    disabled={!!busyAction}
                    className="text-xs hover:underline disabled:opacity-50"
                    style={{ color: '#f87171' }}
                  >
                    Kill this video
                  </button>
                </div>
              )}

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
