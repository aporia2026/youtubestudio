'use client';

import { useEffect, useRef, useState } from 'react';
import type { AskStudioQuestionRow } from '@/lib/ask-studio';
import { InlinePageSkeleton } from '@/components/ui/PageSkeleton';

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

export default function AskStudioPage() {
  const [history, setHistory] = useState<AskStudioQuestionRow[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  async function refreshHistory() {
    try {
      const res = await fetch('/api/ask-studio/questions?limit=30', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHistory(((await res.json()).questions as AskStudioQuestionRow[]) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setHistoryLoaded(true);
    }
  }

  useEffect(() => {
    void refreshHistory();
  }, []);

  async function ask(text?: string) {
    const q = (text ?? question).trim();
    if (!q) return;
    setAsking(true);
    setError(null);
    try {
      const res = await fetch('/api/ask-studio/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
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
    } finally {
      setAsking(false);
      inputRef.current?.focus();
    }
  }

  async function dismiss(id: string) {
    if (!confirm('Delete this question and its answer?')) return;
    try {
      // Check res.ok — fetch() doesn't throw on 4xx/5xx (audit M3).
      const res = await fetch(`/api/ask-studio/questions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setHistory((curr) => curr.filter((q) => q.id !== id));
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
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Press <kbd className="px-1 rounded" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>⌘/Ctrl + Enter</kbd> to send
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
          {history.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              open={openId === q.id}
              onToggle={() => setOpenId(openId === q.id ? null : q.id)}
              onDelete={() => dismiss(q.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  open,
  onToggle,
  onDelete,
}: {
  question: AskStudioQuestionRow;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const isErrored = !!question.error_message;
  const isPending = !question.completed_at && !question.error_message;
  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-start gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
            {question.question}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(question.created_at).toLocaleString()}
            {question.tool_call_count > 0 && ` · ${question.tool_call_count} tool call${question.tool_call_count === 1 ? '' : 's'}`}
            {question.duration_ms !== null && ` · ${Math.round((question.duration_ms / 100)) / 10}s`}
            {isErrored && ' · errored'}
            {isPending && ' · running…'}
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
          {question.error_message && (
            <div className="mb-3 p-3 rounded text-xs" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
              {question.error_message}
            </div>
          )}
          {question.answer && (
            <div
              className="prose prose-invert prose-sm mb-4"
              style={{
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                fontSize: '0.9rem',
                lineHeight: 1.55,
              }}
            >
              {question.answer}
            </div>
          )}
          {question.tool_trace && question.tool_trace.length > 0 && (
            <ToolTrace trace={question.tool_trace as ToolStep[]} />
          )}
          <div className="mt-4 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>
              {question.ai_model}
              {question.input_tokens !== null && ` · ${question.input_tokens} in`}
              {question.output_tokens !== null && ` · ${question.output_tokens} out`}
            </span>
            <button
              type="button"
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
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
