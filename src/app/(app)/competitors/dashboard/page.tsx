'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { MakeVideoButton } from '@/components/video-context/MakeVideoButton';
import {
  classifyOutlier,
  type CompetitorChannelSummary,
  type CompetitorSignals,
  type RecentBreakout,
} from '@/lib/competitor-summary';

interface SummaryResponse {
  signals: CompetitorSignals;
  channels: CompetitorChannelSummary[];
  breakouts: RecentBreakout[];
}

export default function CompetitorDashboardPage() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/competitors/summary?lookbackDays=14&minVsMedian=2.5', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as SummaryResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const acceleratingChannels = useMemo(
    () =>
      data
        ? data.channels.filter((c) => c.momentum !== null && c.momentum >= 1.5 && c.videos_last_7_days >= 2)
        : [],
    [data],
  );
  const stalledChannels = useMemo(
    () =>
      data
        ? data.channels.filter((c) => c.momentum !== null && c.momentum <= 0.5)
        : [],
    [data],
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">Competitor signals</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Cross-channel view: who's on a tear, who's stalled, what just blew up. Per-competitor deep-dive on{' '}
            <Link href="/competitors" className="underline">/competitors</Link>.
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={loading} className="text-sm px-3 py-1.5 rounded" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            <Kpi label="Channels tracked" value={data.signals.channel_count} />
            <Kpi label="Videos tracked" value={data.signals.videos_tracked} />
            <Kpi label="Uploads last 7d" value={data.signals.videos_last_7_days} />
            <Kpi label="Channels accelerating" value={data.signals.channels_accelerating} accent={data.signals.channels_accelerating > 0 ? '#4ade80' : undefined} />
            <Kpi
              label="Oldest sync"
              value={data.signals.oldest_unsynced_hours !== null ? `${data.signals.oldest_unsynced_hours}h` : '—'}
              accent={data.signals.oldest_unsynced_hours !== null && data.signals.oldest_unsynced_hours > 168 ? '#fbbf24' : undefined}
            />
          </div>

          {/* Recent breakouts */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
              Recent breakouts (last 14 days, ≥ 2.5× channel median)
            </h2>
            {data.breakouts.length === 0 ? (
              <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No breakouts in the last 14 days. Either everyone's flat or you need to sync more competitor channels.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {data.breakouts.map((b) => (
                  <BreakoutCard key={b.video_id} breakout={b} />
                ))}
              </div>
            )}
          </section>

          {/* Momentum table */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
              Per-channel momentum
            </h2>
            <div className="glass rounded-xl overflow-hidden">
              <div className="overflow-x-auto scroll-x-fade">
                <table className="w-full text-xs">
                  <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    <tr>
                      <Th>Channel</Th>
                      <Th>Subs</Th>
                      <Th>Tracked</Th>
                      <Th>Last 7d</Th>
                      <Th>Prior 7d</Th>
                      <Th>Momentum</Th>
                      <Th>Median (30d)</Th>
                      <Th>Last upload</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.channels.map((c) => (
                      <ChannelRow key={c.id} c={c} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Quick callouts */}
          {(acceleratingChannels.length > 0 || stalledChannels.length > 0) && (
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {acceleratingChannels.length > 0 && (
                <div className="glass rounded-xl p-4" style={{ borderLeft: '3px solid #4ade80' }}>
                  <h3 className="text-sm font-semibold mb-2" style={{ color: '#4ade80' }}>
                    🚀 Accelerating ({acceleratingChannels.length})
                  </h3>
                  <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {acceleratingChannels.map((c) => (
                      <li key={c.id}>
                        <span style={{ color: 'var(--text-primary)' }}>{c.title}</span> — {c.videos_last_7_days} this wk vs {c.videos_prior_7_days} prior ({c.momentum?.toFixed(1)}×)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stalledChannels.length > 0 && (
                <div className="glass rounded-xl p-4" style={{ borderLeft: '3px solid #fbbf24' }}>
                  <h3 className="text-sm font-semibold mb-2" style={{ color: '#fbbf24' }}>
                    💤 Stalled ({stalledChannels.length})
                  </h3>
                  <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {stalledChannels.map((c) => (
                      <li key={c.id}>
                        <span style={{ color: 'var(--text-primary)' }}>{c.title}</span> — {c.videos_last_7_days} this wk vs {c.videos_prior_7_days} prior
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color: accent ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function BreakoutCard({ breakout }: { breakout: RecentBreakout }) {
  const sev = classifyOutlier(breakout.vs_median_factor);
  const accent = sev === 'viral' ? '#f87171' : sev === 'breakout' ? '#fb923c' : 'var(--text-muted)';
  // Card is no longer the YouTube anchor — instead the title becomes a
  // YouTube link and a "Make video inspired by this" button lives next
  // to it. Nested anchors/buttons aren't valid HTML, and we want both
  // actions to be obvious and unambiguous (rule 16: UI must be clear).
  return (
    <div
      className="glass rounded-xl overflow-hidden flex flex-col"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      {breakout.thumbnail_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={breakout.thumbnail_url}
          alt=""
          style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' }}
        />
      )}
      <div className="p-3 flex-1 flex flex-col">
        <div className="text-xs mb-1 truncate" style={{ color: 'var(--text-muted)' }}>
          {breakout.competitor_title}
        </div>
        <a
          href={`https://www.youtube.com/watch?v=${breakout.video_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium mb-2 leading-snug hover:underline"
          style={{ color: 'var(--text-primary)' }}
        >
          {breakout.video_title} <span style={{ color: 'var(--text-muted)' }}>↗</span>
        </a>
        <div className="text-[10px] flex items-center justify-between mb-2" style={{ color: 'var(--text-muted)' }}>
          <span>{fmtBig(breakout.view_count)} views</span>
          <span style={{ color: accent }}>
            {breakout.vs_median_factor !== null ? `${breakout.vs_median_factor.toFixed(1)}× median` : `${breakout.outlier_score.toFixed(1)}× outlier`}
          </span>
          {breakout.published_at && <span>{daysAgo(breakout.published_at)}d ago</span>}
        </div>
        <div className="mt-auto">
          <MakeVideoButton
            title={breakout.video_title}
            from="Competitors breakout"
            label="+ Make video inspired by this"
            compact
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}

function ChannelRow({ c }: { c: CompetitorChannelSummary }) {
  const momentumColor =
    c.momentum === null
      ? 'var(--text-muted)'
      : c.momentum >= 1.5
        ? '#4ade80'
        : c.momentum >= 0.8
          ? 'var(--text-secondary)'
          : '#fbbf24';
  const momentumLabel = c.momentum === null ? '—' : `${c.momentum.toFixed(1)}×`;
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <Td>
        <Link href={`/competitors/${c.id}`} className="hover:underline">
          {c.title}
        </Link>
      </Td>
      <Td>{fmtBig(c.subscriber_count)}</Td>
      <Td>{c.videos_tracked}</Td>
      <Td>{c.videos_last_7_days}</Td>
      <Td style={{ color: 'var(--text-muted)' }}>{c.videos_prior_7_days}</Td>
      <Td><span style={{ color: momentumColor, fontWeight: 600 }}>{momentumLabel}</span></Td>
      <Td>{c.median_view_count_30d !== null ? fmtBig(c.median_view_count_30d) : '—'}</Td>
      <Td style={{ color: 'var(--text-muted)' }}>{c.last_uploaded_at ? `${daysAgo(c.last_uploaded_at)}d ago` : '—'}</Td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '8px 12px',
        textAlign: 'left',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        fontSize: '0.7rem',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary)', ...style }}>
      {children}
    </td>
  );
}

function fmtBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
}
