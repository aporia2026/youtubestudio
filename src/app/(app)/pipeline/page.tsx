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
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex items-start justify-between mb-2 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold gradient-text mb-1">Auto-pipeline</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            One-click batch creation: idea → script → AI script review → narration → production doc → thumbnail → editor → SEO.
          </p>
        </div>
        <Link href="/pipeline/new" className="btn-primary text-sm no-underline">
          ＋ New batch
        </Link>
      </div>

      <nav className="flex gap-4 text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
        <Link
          href="/pipeline/presets"
          className="hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          Manage presets
        </Link>
        <Link
          href="/pipeline/thumbnail-templates"
          className="hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          Thumbnail templates
        </Link>
      </nav>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </div>
      ) : runs.length === 0 ? (
        <div
          className="glass rounded-xl p-10 text-center"
          style={{ borderStyle: 'dashed' }}
        >
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No pipeline runs yet.{' '}
            <Link href="/pipeline/new" className="underline" style={{ color: 'var(--accent-purple-bright)' }}>
              Start your first batch
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead
              className="text-left"
              style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}
            >
              <tr>
                <Th>Preset</Th>
                <Th>Status</Th>
                <Th>Videos</Th>
                <Th>Spend</Th>
                <Th>Created</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, idx) => (
                <tr
                  key={r.id}
                  style={{
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                  }}
                >
                  <Td>
                    <Link
                      href={`/pipeline/${r.id}`}
                      className="font-medium hover:underline"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {r.preset_name}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {r.video_count_done}/{r.video_count_total} done
                    </span>
                    {r.video_count_failed > 0 && (
                      <span className="ml-2" style={{ color: '#f87171' }}>
                        ({r.video_count_failed} failed)
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      ${Number(r.actual_cost_usd).toFixed(2)}
                    </span>
                    {r.estimated_cost_usd && (
                      <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                        / est ${Number(r.estimated_cost_usd).toFixed(2)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {new Date(r.created_at).toLocaleDateString()}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/pipeline/${r.id}`}
                      className="text-xs hover:underline"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Open →
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-2.5 px-4 font-semibold text-xs uppercase tracking-wider">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-3 px-4">{children}</td>;
}

function StatusBadge({ status }: { status: RunRow['status'] }) {
  const styles: Record<RunRow['status'], { bg: string; color: string; label: string }> = {
    idea_ranking: { bg: 'rgba(245,158,11,0.15)', color: '#fbbf24', label: 'Ranking ideas' },
    running: { bg: 'rgba(6,182,212,0.15)', color: '#22d3ee', label: 'Running' },
    paused: { bg: 'rgba(85,85,119,0.20)', color: 'var(--text-secondary)', label: 'Paused' },
    done: { bg: 'rgba(16,185,129,0.15)', color: '#34d399', label: 'Done' },
    cancelled: { bg: 'rgba(85,85,119,0.20)', color: 'var(--text-muted)', label: 'Cancelled' },
  };
  const s = styles[status];
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  );
}
