'use client';

/**
 * Phase 9.4 — per-format attribution card.
 *
 * Shows the workspace's videos grouped by detected format
 * (explainer / list / story / tutorial / commentary / etc.) with
 * mean AVP and CTR per group. Surfaces the headline finding
 * ("Tutorials average +8.4pp AVP vs your channel mean") so the user
 * sees which format pulls its weight.
 *
 * Hides itself when fewer than 3 buckets have data — single-format
 * channels don't benefit from this view.
 */
import { useEffect, useState } from 'react';
import type { FormatStats, VideoFormat } from '@/lib/format-tags';

interface SummaryResponse {
  stats: FormatStats[];
}

const FORMAT_LABEL: Record<VideoFormat, string> = {
  explainer: 'Explainers',
  list: 'Lists',
  story: 'Stories',
  tutorial: 'Tutorials',
  commentary: 'Commentary',
  interview: 'Interviews',
  vlog: 'Vlogs',
  showcase: 'Showcases',
  other: 'Other',
};

const MIN_BUCKETS = 3;

export function FormatAttributionCard() {
  const [stats, setStats] = useState<FormatStats[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/dashboard/format-attribution', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as SummaryResponse;
        if (!cancelled) setStats(data.stats);
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

  if (loading || !stats || stats.length < MIN_BUCKETS) return null;

  // Channel mean AVP (weighted by video count) — used as the comparison
  // baseline for the headline.
  let totalAvp = 0;
  let totalCount = 0;
  for (const s of stats) {
    if (s.mean_avp !== null) {
      totalAvp += s.mean_avp * s.video_count;
      totalCount += s.video_count;
    }
  }
  const channelMean = totalCount > 0 ? totalAvp / totalCount : null;

  // Best + worst format relative to the channel mean (only formats
  // with ≥3 videos so the comparison is stable).
  const stable = stats.filter((s) => s.video_count >= 3 && s.mean_avp !== null);
  const best = [...stable].sort((a, b) => (b.mean_avp ?? 0) - (a.mean_avp ?? 0))[0];
  const worst = [...stable].sort((a, b) => (a.mean_avp ?? 0) - (b.mean_avp ?? 0))[0];

  let headline: string;
  if (channelMean !== null && best && worst && best.format !== worst.format) {
    const bestDelta = (best.mean_avp ?? 0) - channelMean;
    const worstDelta = (worst.mean_avp ?? 0) - channelMean;
    headline = `${FORMAT_LABEL[best.format]} run ${bestDelta >= 0 ? '+' : ''}${bestDelta.toFixed(1)}pp AVP vs your channel mean; ${FORMAT_LABEL[worst.format].toLowerCase()} run ${worstDelta >= 0 ? '+' : ''}${worstDelta.toFixed(1)}pp.`;
  } else {
    headline = 'Per-format performance breakdown across your tagged videos.';
  }

  // Render rows sorted by video_count desc (matches the lib's order).
  return (
    <section className="glass rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Format attribution
        </h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {stats.length} format{stats.length === 1 ? '' : 's'} tagged
        </span>
      </div>

      <div className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
        {headline}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {stats.map((s) => {
          const delta =
            channelMean !== null && s.mean_avp !== null ? s.mean_avp - channelMean : null;
          const deltaColor =
            delta === null
              ? 'var(--text-muted)'
              : delta > 1
                ? '#4ade80'
                : delta < -1
                  ? '#f87171'
                  : 'var(--text-muted)';
          return (
            <div
              key={s.format}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
            >
              <div style={{ flex: '0 0 110px', color: 'var(--text-secondary)' }}>
                {FORMAT_LABEL[s.format]}
              </div>
              <div style={{ flex: '0 0 60px', color: 'var(--text-muted)', textAlign: 'right' }}>
                {s.video_count} video{s.video_count === 1 ? '' : 's'}
              </div>
              <div
                style={{
                  flex: '0 0 70px',
                  textAlign: 'right',
                  color: 'var(--text-primary)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.mean_avp !== null ? `${s.mean_avp.toFixed(1)}% AVP` : '— AVP'}
              </div>
              {delta !== null && (
                <div
                  style={{
                    flex: '0 0 60px',
                    textAlign: 'right',
                    color: deltaColor,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {delta >= 0 ? '+' : ''}
                  {delta.toFixed(1)}pp
                </div>
              )}
              <div
                style={{
                  flex: '0 0 70px',
                  textAlign: 'right',
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.mean_ctr !== null ? `${s.mean_ctr.toFixed(1)}% CTR` : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
