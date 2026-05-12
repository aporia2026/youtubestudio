'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface RunRow {
  id: string;
  preset_id: string;
  preset_name: string;
  status: 'idea_ranking' | 'running' | 'paused' | 'done' | 'cancelled';
  ideas_count: number;
  estimated_cost_usd: string | null;
  actual_cost_usd: string;
  created_at: string;
  completed_at: string | null;
  video_count_total: number;
  video_count_done: number;
  video_count_failed: number;
}

export default function PipelineListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auto-pipeline/runs', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setRuns((data.runs as RunRow[]) ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load runs');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Auto-pipeline</h1>
          <p className="text-sm text-zinc-500 mt-1">
            One-click batch creation: idea → script → AI script review → narration → production doc → thumbnail → editor.
          </p>
        </div>
        <Link
          href="/pipeline/new"
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
        >
          New batch
        </Link>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center">
          <p className="text-sm text-zinc-500">
            No pipeline runs yet. <Link href="/pipeline/new" className="underline">Start your first batch</Link>.
          </p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 text-left">
            <tr>
              <th className="py-2 pr-3 font-medium">Preset</th>
              <th className="py-2 px-3 font-medium">Status</th>
              <th className="py-2 px-3 font-medium">Videos</th>
              <th className="py-2 px-3 font-medium">Spend</th>
              <th className="py-2 px-3 font-medium">Created</th>
              <th className="py-2 pl-3"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-3 pr-3">
                  <Link href={`/pipeline/${r.id}`} className="font-medium hover:underline">
                    {r.preset_name}
                  </Link>
                </td>
                <td className="py-3 px-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-3 px-3 text-zinc-600 dark:text-zinc-300">
                  {r.video_count_done}/{r.video_count_total} done
                  {r.video_count_failed > 0 && (
                    <span className="ml-2 text-red-600 dark:text-red-400">
                      ({r.video_count_failed} failed)
                    </span>
                  )}
                </td>
                <td className="py-3 px-3 text-zinc-600 dark:text-zinc-300">
                  ${Number(r.actual_cost_usd).toFixed(2)}
                  {r.estimated_cost_usd && (
                    <span className="text-zinc-400 ml-1">/ est ${Number(r.estimated_cost_usd).toFixed(2)}</span>
                  )}
                </td>
                <td className="py-3 px-3 text-zinc-500">
                  {new Date(r.created_at).toLocaleDateString()}
                </td>
                <td className="py-3 pl-3 text-right">
                  <Link
                    href={`/pipeline/${r.id}`}
                    className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RunRow['status'] }) {
  const styles: Record<RunRow['status'], string> = {
    idea_ranking: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    paused: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    cancelled: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  };
  const labels: Record<RunRow['status'], string> = {
    idea_ranking: 'Ranking ideas',
    running: 'Running',
    paused: 'Paused',
    done: 'Done',
    cancelled: 'Cancelled',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}
