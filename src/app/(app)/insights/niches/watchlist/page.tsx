/**
 * Niche watchlist permalink page (server component).
 *
 * Reads `niche_watchlist` directly. Renders a row per watched
 * niche with the 26-week sparkline + the latest snapshot's
 * dimension labels + monetization range. The cron at
 * /api/cron/rescore-niche-watchlist refreshes these every
 * Sunday 04:00 UTC.
 */
import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { listWatchlist } from '@/lib/niche-finder/watchlist';
import { Sparkline } from '@/components/niche-finder/Sparkline';

export default async function WatchlistPage() {
  const session = await requireUser();
  const rows = await listWatchlist(session.ws);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto', color: '#e2e8f0' }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/insights/niches" style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'none' }}>
          ← Discovery hub
        </Link>
      </div>

      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 4 }}>Watchlist</h1>
      <p style={{ color: '#94a3b8', marginBottom: 24, lineHeight: 1.5 }}>
        Niches you&apos;re tracking. We re-score these every Sunday at 04:00 UTC and fire the{' '}
        <code style={codeStyle}>niche_score_spike</code> workflow event when a niche moves by more than the alarm
        threshold (default 10 points).
      </p>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => {
            const last = row.weekly_history[row.weekly_history.length - 1];
            const prev = row.weekly_history[row.weekly_history.length - 2];
            const delta = last && prev ? last.combined - prev.combined : 0;
            return (
              <Link
                key={row.niche_slug}
                href={`/insights/niches/${row.niche_slug}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr auto 1fr',
                  gap: 16,
                  alignItems: 'center',
                  padding: 14,
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 12,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{row.niche_name}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {row.weekly_history.length} snapshot{row.weekly_history.length === 1 ? '' : 's'} ·
                    {row.last_rescored_at ? ` last refreshed ${formatDate(row.last_rescored_at)}` : ' awaiting first re-score'}
                  </div>
                </div>

                <Sparkline values={row.weekly_history.map((s) => s.combined)} width={140} height={36} />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: '#cbd5e1' }}>
                  {last ? (
                    <>
                      <div>
                        <span style={{ color: '#64748b' }}>Combined</span>{' '}
                        <strong>{Math.round(last.combined * 100)}</strong>
                        {prev && (
                          <span
                            style={{
                              marginLeft: 6,
                              color: delta > 0 ? '#22c55e' : delta < 0 ? '#f87171' : '#64748b',
                            }}
                          >
                            {delta > 0 ? '↑' : delta < 0 ? '↓' : '·'} {Math.abs(delta * 100).toFixed(1)}
                          </span>
                        )}
                      </div>
                      <div>
                        <span style={{ color: '#64748b' }}>Demand</span> {last.demand_label} ·{' '}
                        <span style={{ color: '#64748b' }}>Crowdedness</span> {last.supply_label}
                      </div>
                      <div>
                        <span style={{ color: '#64748b' }}>Per 1k</span> $
                        {last.monetization_low_usd.toFixed(0)}–${last.monetization_high_usd.toFixed(0)}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#64748b' }}>No snapshots yet.</div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px', color: '#94a3b8' }}>
      <h2 style={{ fontSize: 18, color: '#e2e8f0', marginBottom: 8 }}>Nothing saved yet</h2>
      <p style={{ fontSize: 14, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 20px' }}>
        Open any niche deep-dive and click <strong>+ Watchlist</strong> to track it. We&apos;ll refresh the scores
        every Sunday and show the trajectory here.
      </p>
      <Link
        href="/insights/niches"
        style={{
          display: 'inline-block',
          padding: '10px 18px',
          background: '#22c55e',
          color: '#0a0e16',
          borderRadius: 10,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Find a niche
      </Link>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

const codeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  padding: '1px 6px',
  borderRadius: 4,
  fontSize: 12,
};
