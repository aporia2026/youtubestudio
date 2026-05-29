'use client';

/**
 * Compact "competitor signals" card for the main dashboard. Hits
 * `/api/competitors/summary` independently — does NOT pipe into
 * the main DashboardSummary plumbing because the dashboard already
 * has too many sections and competitor data is its own beat.
 *
 * Renders nothing while loading / on error / when no competitors are
 * tracked, so the card "appears" only when there's something to show.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CompetitorSignals } from '@/lib/competitor-summary';

interface SummaryResponse {
  signals: CompetitorSignals;
}

export function CompetitorSignalsCard() {
  const [signals, setSignals] = useState<CompetitorSignals | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/competitors/summary?lookbackDays=14&minVsMedian=2.5', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as SummaryResponse;
        if (!cancelled) setSignals(data.signals);
      } catch {
        /* silent — dashboard card only appears when data is available */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!signals || signals.channel_count === 0) return null;

  const breakout = signals.most_recent_breakout;
  return (
    <Link
      href="/competitors/dashboard"
      className="glass rounded-xl p-4 block hover:bg-white/[0.02] transition-colors"
      style={{ borderLeft: signals.channels_accelerating > 0 || breakout ? '3px solid #4ade80' : '3px solid transparent' }}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Competitor signals
        </h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {signals.channel_count} tracked · {signals.videos_last_7_days} uploads this week
        </span>
      </div>

      {breakout ? (
        <div className="text-xs space-y-1">
          <div style={{ color: 'var(--text-secondary)' }}>
            🔥 <strong style={{ color: 'var(--text-primary)' }}>{breakout.competitor_title}</strong> just broke out:
          </div>
          <div className="ml-5 truncate" style={{ color: 'var(--text-muted)' }}>
            "{breakout.video_title}" — {breakout.vs_median_factor !== null ? `${breakout.vs_median_factor.toFixed(1)}× their median` : `${breakout.outlier_score.toFixed(1)}× outlier`}
          </div>
        </div>
      ) : signals.channels_accelerating > 0 ? (
        <div className="text-xs" style={{ color: '#4ade80' }}>
          🚀 {signals.channels_accelerating} channel{signals.channels_accelerating === 1 ? '' : 's'} accelerating cadence this week
        </div>
      ) : (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No breakouts in the last 14 days. Click to see momentum + per-channel cadence.
        </div>
      )}

      {signals.oldest_unsynced_hours !== null && signals.oldest_unsynced_hours > 168 && (
        <div className="text-[10px] mt-2" style={{ color: '#fbbf24' }}>
          ⚠ Oldest sync was {Math.round(signals.oldest_unsynced_hours / 24)}d ago — re-sync for fresher signals.
        </div>
      )}
    </Link>
  );
}
