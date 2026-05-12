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
    // Light polling — every 10s. Heavy enough to feel live but
    // doesn't hammer the DB.
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) return <div className="p-6 text-sm text-zinc-500">Loading…</div>;
  if (error || !run) {
    return (
      <div className="p-6">
        <Link href="/pipeline" className="text-sm text-zinc-500 hover:underline">
          ← All batches
        </Link>
        <div className="mt-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
          {error || 'Run not found.'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <Link href="/pipeline" className="text-sm text-zinc-500 hover:underline">
          ← All batches
        </Link>
        <div className="flex items-baseline justify-between mt-2">
          <h1 className="text-2xl font-semibold">{run.preset_name}</h1>
          <div className="text-sm text-zinc-500">
            ${Number(run.actual_cost_usd).toFixed(2)}
            {run.estimated_cost_usd && (
              <span className="text-zinc-400 ml-1">/ est ${Number(run.estimated_cost_usd).toFixed(2)}</span>
            )}
          </div>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          {run.ideas_count} videos · QA threshold {run.qa_min_score} ·
          Script gate {run.script_gate_enabled ? 'on' : 'off'} · Created{' '}
          {new Date(run.created_at).toLocaleString()}
        </p>
      </header>

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
      <div className="border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center">
        <p className="text-sm text-zinc-500">
          Generating ideas… come back in a minute. This page refreshes every 10 seconds.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-zinc-500 mb-3">
        Drag to rank. Order = priority (top runs first). When you&apos;re happy, click <strong>Start the
        batch</strong> and the pipeline runs unattended.
      </p>
      <ul className="space-y-2 mb-6">
        {rankOrder.map((id, idx) => {
          const v = byId.get(id);
          if (!v) return null;
          return (
            <li
              key={id}
              draggable
              onDragStart={() => onDragStart(idx)}
              onDragOver={(e) => onDragOver(e, idx)}
              onDragEnd={onDragEnd}
              className={`flex items-start gap-3 p-3 rounded-md border bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 cursor-move ${
                dragIdx === idx ? 'opacity-50' : ''
              }`}
            >
              <div className="w-8 shrink-0 text-zinc-500 text-sm font-mono pt-0.5">#{idx + 1}</div>
              <div className="flex-1">
                <div className="font-medium text-sm">{v.idea_title}</div>
                {v.idea_hook && (
                  <div className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{v.idea_hook}</div>
                )}
              </div>
              <div className="text-xs text-zinc-400">⋮⋮</div>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <button
          onClick={() => void onCommit()}
          disabled={committing || rankOrder.length === 0}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-5 py-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {committing ? 'Starting…' : 'Start the batch'}
        </button>
      </div>
    </>
  );
}
