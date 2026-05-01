'use client';

import { useEffect, useState } from 'react';

interface AnalyticsRow {
  youtube_video_id: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  duration_seconds: number | null;
  published_at: string | null;
  title: string | null;
  thumbnail_url: string | null;
  impressions: number | null;
  ctr_percentage: number | null;
  average_view_duration_seconds: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;
  retention_curve: Array<{ position: number; retention: number }> | null;
  data_source: 'data' | 'analytics' | 'mixed' | 'partial';
  fetched_at: string;
}

/**
 * Inline analytics panel for a published schedule item. On mount, fetches
 * the cached row; if missing, surfaces a "Sync now" button that POSTs to
 * the same route to populate it.
 *
 * Renders snapshot stats (views/likes/comments) always, plus a performance
 * row (impressions, CTR, AVD, AVP, subs gained) when Analytics scope was
 * available, plus a sparkline-y retention curve when one was returned.
 */
export function AnalyticsPanel({ scheduleItemId }: { scheduleItemId: string }) {
  const [row, setRow] = useState<AnalyticsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSync, setNeedsSync] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/schedule/${scheduleItemId}/analytics`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setRow(data.analytics);
          setNeedsSync(false);
        } else if (data.status === 'not_synced') {
          setNeedsSync(true);
        } else {
          setError(data.error || 'Failed to load analytics');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [scheduleItemId]);

  async function syncNow() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedule/${scheduleItemId}/analytics`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setRow(data.analytics);
      setNeedsSync(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  if (needsSync) {
    return (
      <div
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
          No analytics cached for this video yet.
        </p>
        <button onClick={syncNow} disabled={syncing} className="btn-primary text-sm">
          {syncing ? 'Syncing…' : '📊 Sync analytics now'}
        </button>
        {error && (
          <p style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{error}</p>
        )}
      </div>
    );
  }

  if (error || !row) {
    return (
      <div style={{ color: '#ef4444', fontSize: 13 }}>
        {error || 'No analytics available.'}
      </div>
    );
  }

  const showAnalytics = row.data_source === 'analytics' || row.data_source === 'mixed';

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {row.title || 'Video analytics'}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Synced {new Date(row.fetched_at).toLocaleString()}
          </span>
          <button onClick={syncNow} disabled={syncing} className="btn-secondary text-xs">
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <StatRow
        items={[
          { label: 'Views', value: formatBig(row.views) },
          { label: 'Likes', value: formatBig(row.likes) },
          { label: 'Comments', value: formatBig(row.comments) },
          { label: 'Length', value: formatDuration(row.duration_seconds) },
        ]}
      />

      {showAnalytics ? (
        <StatRow
          items={[
            { label: 'Impressions', value: formatBig(row.impressions) },
            { label: 'CTR', value: row.ctr_percentage !== null ? `${row.ctr_percentage.toFixed(2)}%` : '—' },
            {
              label: 'Avg view duration',
              value: formatDuration(row.average_view_duration_seconds),
            },
            {
              label: 'Avg view %',
              value: row.average_view_percentage !== null ? `${row.average_view_percentage.toFixed(1)}%` : '—',
            },
            { label: 'Subs gained', value: formatBig(row.subscribers_gained) },
          ]}
        />
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          Performance metrics (CTR, impressions, retention) require the YouTube Analytics scope.
          Re-connect this channel via <a href="/channel" style={{ textDecoration: 'underline' }}>/channel</a>
          {' '}to grant it; existing OAuth predates the scope.
        </p>
      )}

      {row.retention_curve && row.retention_curve.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Audience retention curve
          </div>
          <RetentionCurve points={row.retention_curve} />
        </div>
      )}
    </div>
  );
}

function StatRow({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        gap: 12,
      }}
    >
      {items.map(it => (
        <div key={it.label}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {it.label}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function RetentionCurve({ points }: { points: Array<{ position: number; retention: number }> }) {
  // Inline SVG sparkline — no chart lib dependency. 320×60 viewBox; line
  // colored by terminal retention (green if > 0.4, amber if > 0.2, else red).
  if (points.length < 2) return null;
  const W = 320;
  const H = 60;
  const xs = points.map(p => Math.max(0, Math.min(1, p.position)));
  const ys = points.map(p => Math.max(0, Math.min(1, p.retention)));
  const path = points
    .map((_p, i) => {
      const x = xs[i] * W;
      const y = H - ys[i] * H;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const finalRetention = ys[ys.length - 1]!;
  const stroke = finalRetention > 0.4 ? '#10b981' : finalRetention > 0.2 ? '#f59e0b' : '#ef4444';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Audience retention curve">
      <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(255,255,255,0.1)" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

function formatBig(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
