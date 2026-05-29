'use client';

/**
 * Phase 9.2 — workspace-level traffic-source mix on the main dashboard.
 *
 * Surfaces the single highest-leverage channel-health signal: how
 * the algorithm's vote (Suggested-feed share) is shifting over time.
 * The card auto-hides when:
 *   - No videos have a traffic_source_breakdown yet (cold-start
 *     workspace or syncs predate Phase 9.2)
 *   - There aren't enough videos to compute a meaningful delta
 *
 * Pulls /api/dashboard/traffic-sources independently of the rest of
 * the dashboard summary because the traffic-source aggregation is a
 * separate beat (matches the CompetitorSignalsCard pattern).
 */
import { useEffect, useState } from 'react';
import type { TrafficSourceSummary } from '@/lib/traffic-source-summary';

const SOURCE_LABEL: Record<string, string> = {
  YT_SEARCH: 'YouTube Search',
  RELATED_VIDEO: 'Suggested',
  EXT_URL: 'External',
  YT_OTHER_PAGE: 'Browse',
  YT_CHANNEL: 'Channel page',
  PLAYLIST: 'Playlists',
  SHORTS: 'Shorts feed',
  NOTIFICATION: 'Notifications',
  ADVERTISING: 'Ads',
  END_SCREEN: 'End screens',
  // Common alternates (the API has been seen to return either casing):
  BROWSE: 'Browse',
  SEARCH: 'YouTube Search',
  SUGGESTED: 'Suggested',
  EXTERNAL: 'External',
  SHORTS_FEED: 'Shorts feed',
  CHANNEL: 'Channel page',
  OTHER: 'Other',
};

function sourceLabel(src: string): string {
  return SOURCE_LABEL[src] ?? src.replace(/_/g, ' ').toLowerCase();
}

const MIN_VIDEOS_FOR_TREND = 2;

export function TrafficSourceCard() {
  const [summary, setSummary] = useState<TrafficSourceSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/dashboard/traffic-sources', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as TrafficSourceSummary;
        if (!cancelled) setSummary(data);
      } catch {
        /* silent — card hides on error */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !summary || summary.recent_video_count === 0) return null;

  const topSources = Object.entries(summary.recent_pct)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Headline: biggest mover above the noise threshold (1pp). Falls
  // back to a static "current mix" when there's no prior window.
  const haveTrend =
    summary.prior_video_count >= MIN_VIDEOS_FOR_TREND && summary.deltas.length > 0;
  const biggestMover = haveTrend
    ? summary.deltas.find((d) => Math.abs(d.delta_pct) >= 1)
    : null;

  let headline: { text: string; tone: 'positive' | 'negative' | 'neutral' };
  if (biggestMover) {
    const sign = biggestMover.delta_pct >= 0 ? '+' : '';
    const isSuggestedRising =
      (biggestMover.source === 'SUGGESTED' || biggestMover.source === 'RELATED_VIDEO') &&
      biggestMover.delta_pct > 0;
    const tone =
      isSuggestedRising
        ? 'positive'
        : biggestMover.delta_pct < -2
          ? 'negative'
          : 'neutral';
    headline = {
      text: `${sourceLabel(biggestMover.source)} share is ${sign}${biggestMover.delta_pct.toFixed(1)}pp vs the prior month.`,
      tone,
    };
  } else {
    headline = {
      text: 'Current traffic mix across recent uploads.',
      tone: 'neutral',
    };
  }

  return (
    <section
      className="glass rounded-xl p-4"
      style={{
        borderLeft:
          headline.tone === 'positive'
            ? '3px solid #4ade80'
            : headline.tone === 'negative'
              ? '3px solid #f87171'
              : '3px solid transparent',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Traffic sources
        </h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {summary.recent_video_count} video{summary.recent_video_count === 1 ? '' : 's'} · last 30d
        </span>
      </div>

      <div className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
        {headline.text}
      </div>

      {topSources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {topSources.map(([src, pct]) => {
            const delta = haveTrend
              ? summary.deltas.find((d) => d.source === src)?.delta_pct ?? 0
              : null;
            const deltaLabel =
              delta === null
                ? null
                : Math.abs(delta) < 0.1
                  ? '→ 0'
                  : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp`;
            const deltaColor =
              delta === null || Math.abs(delta) < 0.5
                ? 'var(--text-muted)'
                : delta > 0
                  ? '#4ade80'
                  : '#f87171';
            return (
              <div key={src} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <div style={{ flex: '0 0 110px', color: 'var(--text-secondary)' }}>
                  {sourceLabel(src)}
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, pct)}%`,
                      height: '100%',
                      background:
                        'linear-gradient(90deg, rgba(124,58,237,0.6), rgba(6,182,212,0.6))',
                    }}
                  />
                </div>
                <div
                  style={{
                    flex: '0 0 60px',
                    textAlign: 'right',
                    color: 'var(--text-primary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {pct.toFixed(1)}%
                </div>
                {deltaLabel !== null && (
                  <div
                    style={{
                      flex: '0 0 60px',
                      textAlign: 'right',
                      color: deltaColor,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {deltaLabel}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
