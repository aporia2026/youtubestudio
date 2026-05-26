'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
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
  updated_at: string;
}

export default function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = usePromise(params);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankOrder, setRankOrder] = useState<string[]>([]);
  const [committing, setCommitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/auto-pipeline/runs/${runId}`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) throw new Error('Run not found.');
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setRun(data.run as RunDetail);
      setVideos((data.videos as VideoSummary[]) ?? []);
      if (data.run?.status === 'idea_ranking') {
        setRankOrder(((data.videos as VideoSummary[]) ?? []).map((v) => v.id));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

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
      <p className="text-sm mt-1 mb-6" style={{ color: 'var(--text-muted)' }}>
        {run.ideas_count} videos · QA threshold {run.qa_min_score} ·
        Script gate {run.script_gate_enabled ? 'on' : 'off'} · Created{' '}
        {new Date(run.created_at).toLocaleString()}
      </p>

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
