'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskStudioQuestionRow } from '@/lib/ask-studio';
import { InlinePageSkeleton } from '@/components/ui/PageSkeleton';
import { ModelSelector } from '@/components/ui/ModelSelector';
import {
  getAskStudioSupportedModels,
  getFeatureDefaultModelId,
  getModelById,
  isAskStudioSupportedModel,
} from '@/lib/ai-models';

interface ToolStep {
  iteration: number;
  tool_name: string;
  input: unknown;
  result: { ok: boolean; data?: unknown; error?: string };
}

const SUGGESTED_PROMPTS = [
  "Which of my videos from the last 30 days underperformed the most?",
  "What's the upload count by channel this quarter?",
  "Which channel has the best average CTR right now?",
  "List my top 5 videos by AVP from the last 90 days",
  "What's scheduled to publish in the next two weeks?",
  "Are any of my A/B tests still running?",
];

// Persisted manual override — when the user picks a model on this page,
// we remember the choice across reloads. Separate from the workspace-wide
// `feature_model_defaults_v2` so changing it here doesn't touch the saved
// default that other surfaces / API callers see.
const LOCAL_PICK_KEY = 'askStudio.lastModelId';

// Server-rendered default. Stable across SSR and the first client paint so
// React doesn't fire a hydration mismatch warning. We swap in the user's
// localStorage pick (if any) inside a useEffect after mount.
const SERVER_INITIAL_MODEL_ID = 'claude-haiku-4-5-20251001';

function loadClientPreferredModelId(): string {
  if (typeof window === 'undefined') return SERVER_INITIAL_MODEL_ID;
  try {
    const local = localStorage.getItem(LOCAL_PICK_KEY);
    if (local && isAskStudioSupportedModel(local)) return local;
  } catch { /* swallow — fall through to workspace default */ }
  const fromDefaults = getFeatureDefaultModelId('ask-studio');
  if (isAskStudioSupportedModel(fromDefaults)) return fromDefaults;
  return SERVER_INITIAL_MODEL_ID;
}

export default function AskStudioPage() {
  const [history, setHistory] = useState<AskStudioQuestionRow[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [modelId, setModelId] = useState<string>(SERVER_INITIAL_MODEL_ID);

  // Per-thread state keyed by root id. Threads are lazy-loaded when the
  // user expands a card so the initial list query stays cheap.
  const [threadsById, setThreadsById] = useState<Record<string, AskStudioQuestionRow[]>>({});
  const [threadLoading, setThreadLoading] = useState<Record<string, boolean>>({});
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Record<string, boolean>>({});

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Stable allowlist for the ModelSelector. Computed once — the supported
  // set is derived from the registry and doesn't change at runtime.
  const allowedIds = useMemo(
    () => new Set(getAskStudioSupportedModels().map((m) => m.id)),
    [],
  );

  function handleModelChange(next: string) {
    setModelId(next);
    try { localStorage.setItem(LOCAL_PICK_KEY, next); } catch { /* ignore quota */ }
  }

  async function refreshHistory(opts: { autoExpandLatestError?: boolean } = {}) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/ask-studio/questions?limit=30', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = ((await res.json()).questions as AskStudioQuestionRow[]) || [];
      setHistory(rows);
      if (opts.autoExpandLatestError) {
        const latest = rows[0];
        if (latest && latest.error_message) setOpenId(latest.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setHistoryLoaded(true);
    }
  }

  async function fetchThread(rootId: string) {
    setThreadLoading((prev) => ({ ...prev, [rootId]: true }));
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/ask-studio/questions/${rootId}/thread`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const turns = ((await res.json()).turns as AskStudioQuestionRow[]) || [];
      setThreadsById((prev) => ({ ...prev, [rootId]: turns }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thread');
    } finally {
      setThreadLoading((prev) => ({ ...prev, [rootId]: false }));
    }
  }

  useEffect(() => {
    void refreshHistory();
    const preferred = loadClientPreferredModelId();
    if (preferred !== modelId) setModelId(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load a thread the first time its card is expanded. Subsequent
  // expand/collapse uses the cached array. Replies invalidate via an
  // explicit fetchThread call inside reply().
  useEffect(() => {
    if (openId && !threadsById[openId] && !threadLoading[openId]) {
      void fetchThread(openId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  async function ask(text?: string) {
    const q = (text ?? question).trim();
    if (!q) return;
    setAsking(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/ask-studio/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, modelId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { id: string };
      setQuestion('');
      await refreshHistory();
      setOpenId(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ask failed');
      await refreshHistory({ autoExpandLatestError: true });
    } finally {
      setAsking(false);
      inputRef.current?.focus();
    }
  }

  async function reply(rootId: string) {
    const text = (replyText[rootId] || '').trim();
    if (!text) return;
    const turns = threadsById[rootId];
    if (!turns || turns.length === 0) return;
    const latestTurn = turns[turns.length - 1];
    setReplying((prev) => ({ ...prev, [rootId]: true }));
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/ask-studio/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, parentId: latestTurn.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      setReplyText((prev) => ({ ...prev, [rootId]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reply failed');
    } finally {
      // Refetch the thread either way — on success the new turn appears,
      // on failure the errored row shows with its error_message visible.
      await fetchThread(rootId);
      setReplying((prev) => ({ ...prev, [rootId]: false }));
    }
  }

  async function dismiss(id: string) {
    if (!confirm('Delete this entire thread (question + all replies)?')) return;
    try {
      // Check res.ok — fetch() doesn't throw on 4xx/5xx (audit M3).
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/ask-studio/questions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setHistory((curr) => curr.filter((q) => q.id !== id));
      setThreadsById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (openId === id) setOpenId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Ask Studio</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Natural-language questions about your channels, videos, and projects. The agent runs read-only queries on your workspace data — never makes up numbers.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      <div className="glass rounded-xl p-5 mb-6">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask();
            }
          }}
          rows={3}
          className="input-field w-full"
          placeholder="Ask anything about your data — &quot;which channels uploaded most last month?&quot;"
          disabled={asking}
        />
        <div className="mt-3 flex items-end justify-between gap-3 flex-wrap">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Press <kbd className="px-1 rounded" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>⌘/Ctrl + Enter</kbd> to send
          </div>
          <div className="flex items-end gap-3 ml-auto">
            <div className="w-72">
              <ModelSelector
                value={modelId}
                onChange={handleModelChange}
                label=""
                allowedIds={allowedIds}
              />
            </div>
            <button
              type="button"
              onClick={() => ask()}
              disabled={asking || !question.trim()}
              className="btn-primary text-sm"
            >
              {asking ? 'Thinking…' : '▶ Ask'}
            </button>
          </div>
        </div>
        {!asking && history.length === 0 && (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
              Try
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setQuestion(p);
                    void ask(p);
                  }}
                  className="text-xs px-3 py-1.5 rounded-full"
                  style={{
                    background: 'var(--bg-card)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!historyLoaded && history.length === 0 && <InlinePageSkeleton rows={3} />}

      {history.length > 0 && (
        <div className="space-y-3">
          {history.map((root) => (
            <ThreadCard
              key={root.id}
              root={root}
              thread={threadsById[root.id]}
              threadLoading={!!threadLoading[root.id]}
              open={openId === root.id}
              onToggle={() => setOpenId(openId === root.id ? null : root.id)}
              onDelete={() => dismiss(root.id)}
              replyDraft={replyText[root.id] || ''}
              onReplyDraftChange={(text) => setReplyText((prev) => ({ ...prev, [root.id]: text }))}
              onReply={() => reply(root.id)}
              replying={!!replying[root.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadCard({
  root,
  thread,
  threadLoading,
  open,
  onToggle,
  onDelete,
  replyDraft,
  onReplyDraftChange,
  onReply,
  replying,
}: {
  root: AskStudioQuestionRow;
  thread: AskStudioQuestionRow[] | undefined;
  threadLoading: boolean;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  replyDraft: string;
  onReplyDraftChange: (text: string) => void;
  onReply: () => void;
  replying: boolean;
}) {
  const isRootErrored = !!root.error_message;
  const isRootPending = !root.completed_at && !root.error_message;
  // For the collapsed header: prefer the live thread's count if loaded,
  // otherwise hide the reply count entirely (we don't know it yet).
  const replyCount = thread ? Math.max(0, thread.length - 1) : null;
  // The latest turn — used to anchor the reply (parentId) and to gate
  // whether the reply input is enabled.
  const latestTurn = thread && thread.length > 0 ? thread[thread.length - 1] : null;
  const latestPending = latestTurn ? !latestTurn.completed_at && !latestTurn.error_message : false;
  const lockedModel = getModelById(root.ai_model);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-start gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
            {root.question}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(root.created_at).toLocaleString()}
            {replyCount !== null && replyCount > 0 && ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`}
            {root.tool_call_count > 0 && ` · ${root.tool_call_count} tool call${root.tool_call_count === 1 ? '' : 's'}`}
            {root.duration_ms !== null && ` · ${Math.round((root.duration_ms / 100)) / 10}s`}
            {isRootErrored && ' · errored'}
            {isRootPending && ' · running…'}
          </div>
        </div>
        <span
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
            color: 'var(--text-muted)',
            fontSize: 14,
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          {threadLoading && !thread && (
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Loading thread…
            </div>
          )}
          {(thread ?? [root]).map((turn, idx) => (
            <TurnBlock key={turn.id} turn={turn} isRoot={idx === 0} />
          ))}

          {/* Reply composer — only renders once the thread has loaded and
              the latest turn is settled (not still running). */}
          {thread && latestTurn && !latestPending && (
            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
              <textarea
                value={replyDraft}
                onChange={(e) => onReplyDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onReply();
                  }
                }}
                rows={2}
                className="input-field w-full text-sm"
                placeholder="Reply to continue the thread…"
                disabled={replying}
              />
              <div className="mt-2 flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span>
                  Replying with <span style={{ color: 'var(--text-secondary)' }}>{lockedModel?.name ?? root.ai_model}</span>
                  <span className="opacity-60"> · model locked to the thread</span>
                </span>
                <button
                  type="button"
                  onClick={onReply}
                  disabled={replying || !replyDraft.trim()}
                  className="btn-primary text-xs"
                >
                  {replying ? 'Sending…' : '▶ Reply'}
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end text-xs" style={{ color: 'var(--text-muted)' }}>
            <button
              type="button"
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
            >
              Delete thread
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnBlock({ turn, isRoot }: { turn: AskStudioQuestionRow; isRoot: boolean }) {
  return (
    <div className={isRoot ? '' : 'mt-5 pt-4 border-t'} style={isRoot ? undefined : { borderColor: 'var(--border)' }}>
      {/* Reply turns get a small "You:" header showing their question text.
          The root turn's question is already in the card header. */}
      {!isRoot && (
        <div
          className="mb-2 text-xs px-3 py-2 rounded"
          style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
        >
          <span className="opacity-60 mr-1">You:</span>
          {turn.question}
        </div>
      )}

      {turn.error_message && (
        <div
          className="mb-3 p-3 rounded text-xs"
          style={{
            background: 'rgba(239,68,68,0.10)',
            color: '#fca5a5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--font-geist-mono, ui-monospace, monospace)',
            lineHeight: 1.5,
          }}
        >
          <div className="mb-1 font-semibold" style={{ color: '#f87171' }}>Error</div>
          {turn.error_message}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard?.writeText(turn.error_message || '').catch(() => {});
            }}
            className="mt-2 text-[10px] px-2 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.18)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            Copy error
          </button>
        </div>
      )}

      {turn.answer && (
        <div
          className="prose prose-invert prose-sm mb-3"
          style={{
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            fontSize: '0.9rem',
            lineHeight: 1.55,
          }}
        >
          {turn.answer}
        </div>
      )}

      {turn.tool_trace && turn.tool_trace.length > 0 && (
        <ToolTrace trace={turn.tool_trace as ToolStep[]} />
      )}

      <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {turn.ai_model}
        {turn.input_tokens !== null && ` · ${turn.input_tokens} in`}
        {turn.output_tokens !== null && ` · ${turn.output_tokens} out`}
        {turn.duration_ms !== null && ` · ${Math.round((turn.duration_ms / 100)) / 10}s`}
      </div>
    </div>
  );
}

function ToolTrace({ trace }: { trace: ToolStep[] }) {
  return (
    <details className="text-xs">
      <summary
        className="cursor-pointer mb-2"
        style={{ color: 'var(--text-muted)' }}
      >
        Tool trace ({trace.length} call{trace.length === 1 ? '' : 's'})
      </summary>
      <div className="space-y-2 pl-3 border-l" style={{ borderColor: 'var(--border)' }}>
        {trace.map((step, idx) => (
          <div key={idx}>
            <div className="font-mono" style={{ color: step.result.ok ? '#94a3b8' : '#f87171' }}>
              #{idx + 1} {step.tool_name}({JSON.stringify(step.input)})
            </div>
            <div
              className="font-mono text-[10px] pl-2"
              style={{ color: step.result.ok ? 'var(--text-secondary)' : '#f87171' }}
            >
              {step.result.ok
                ? Array.isArray(step.result.data)
                  ? `→ ${step.result.data.length} row${step.result.data.length === 1 ? '' : 's'}`
                  : `→ ${typeof step.result.data === 'object' && step.result.data ? '1 object' : 'ok'}`
                : `× ${step.result.error}`}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
