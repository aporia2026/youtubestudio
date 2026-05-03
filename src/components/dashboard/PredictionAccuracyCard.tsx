'use client';

/**
 * Phase 8.5 — dashboard "Prediction accuracy" card.
 *
 * Pulls aggregated prediction_outcomes for the workspace (last 30 days
 * by default) and surfaces:
 *
 *   - overall MAE (mean absolute error) in percentage points
 *   - per-bucket MAE + bias (hook / early / midroll / outro)
 *   - trend headline ("your script hooks are getting better; midroll
 *     retention is getting worse")
 *
 * The card hides itself entirely when there are zero captured outcomes,
 * so cold-start workspaces don't see an empty widget. Once the
 * capture-prediction-outcomes cron has fired even once, the card lights
 * up with whatever data is available.
 *
 * Data source: GET /api/dashboard/prediction-accuracy?lookbackDays=30.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  AccuracyBucketStat,
  AccuracyTrendBucket,
  PredictionAccuracySummary,
} from '@/lib/prediction-outcomes';

// Threshold for calling a bucket "improving" or "regressing" in the
// headline. <0.5pp shifts are noise; we only call out shifts above
// this so the user trusts the signal.
const TREND_HEADLINE_THRESHOLD_PP = 0.5;

export function PredictionAccuracyCard() {
  const [summary, setSummary] = useState<PredictionAccuracySummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/dashboard/prediction-accuracy?lookbackDays=30', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as PredictionAccuracySummary;
        if (!cancelled) setSummary(data);
      } catch {
        /* silent — card hides itself on error */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide entirely while loading or when there's no captured data yet.
  // The cron writes its first row 14 days after a project's first
  // publish — until then the card would just be noise.
  if (loading || !summary || summary.outcome_count === 0) return null;

  const headline = buildTrendHeadline(summary.trend);
  const lastCaptured = summary.last_captured_at
    ? formatRelative(summary.last_captured_at)
    : null;

  return (
    <section
      className="glass rounded-xl p-4"
      style={{ borderLeft: headline.tone === 'positive' ? '3px solid #4ade80' : headline.tone === 'negative' ? '3px solid #f87171' : '3px solid transparent' }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Prediction accuracy
        </h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {summary.outcome_count} outcome{summary.outcome_count === 1 ? '' : 's'} · last 30d
          {lastCaptured ? ` · updated ${lastCaptured}` : ''}
        </span>
      </div>

      <div className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
        {headline.text}
        {summary.overall_mae_pct !== null && (
          <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
            (overall MAE {summary.overall_mae_pct.toFixed(1)}pp)
          </span>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 8,
        }}
      >
        {summary.buckets.map((b, i) => {
          const trend = summary.trend[i];
          return <BucketTile key={b.key} bucket={b} trend={trend} />;
        })}
      </div>

      <div className="mt-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Bias: <span style={{ color: '#4ade80' }}>positive</span> = predictions ran low (real
        viewers held longer);{' '}
        <span style={{ color: '#f87171' }}>negative</span> = predictions ran high. {' '}
        <Link href="/retention" className="hover:underline" style={{ color: 'var(--text-secondary)' }}>
          Open the predictor →
        </Link>
      </div>
    </section>
  );
}

function BucketTile({
  bucket,
  trend,
}: {
  bucket: AccuracyBucketStat;
  trend: AccuracyTrendBucket | undefined;
}) {
  const trendDelta = trend?.delta_pct ?? null;
  const trendArrow =
    trendDelta === null || Math.abs(trendDelta) < TREND_HEADLINE_THRESHOLD_PP
      ? '→'
      : trendDelta < 0
        ? '↓' // MAE shrinking = good
        : '↑'; // MAE growing = bad
  const trendColor =
    trendDelta === null || Math.abs(trendDelta) < TREND_HEADLINE_THRESHOLD_PP
      ? 'var(--text-muted)'
      : trendDelta < 0
        ? '#4ade80'
        : '#f87171';

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>
          {bucket.label}
        </div>
        <span className="text-[11px]" style={{ color: trendColor, fontWeight: 600 }}>
          {trendArrow}{' '}
          {trendDelta === null
            ? '—'
            : `${trendDelta > 0 ? '+' : ''}${trendDelta.toFixed(1)}pp`}
        </span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
        {bucket.mae_pct.toFixed(1)}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>pp MAE</span>
      </div>
      <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
        bias{' '}
        <span
          style={{
            color: bucket.bias_pct > 0.5 ? '#4ade80' : bucket.bias_pct < -0.5 ? '#f87171' : 'var(--text-muted)',
          }}
        >
          {bucket.bias_pct > 0 ? '+' : ''}
          {bucket.bias_pct.toFixed(1)}pp
        </span>
        {' · '}
        {bucket.outcome_count} sample{bucket.outcome_count === 1 ? '' : 's'}
      </div>
    </div>
  );
}

interface Headline {
  text: string;
  tone: 'positive' | 'negative' | 'neutral';
}

/** Pick the most-improved + most-regressed bucket above the noise
 *  threshold and stitch a one-line headline. Returns a neutral message
 *  when no bucket has moved meaningfully. Pure inline — small enough
 *  not to warrant its own module. */
function buildTrendHeadline(trend: AccuracyTrendBucket[]): Headline {
  const moved = trend
    .filter((t) => t.delta_pct !== null && Math.abs(t.delta_pct) >= TREND_HEADLINE_THRESHOLD_PP)
    .map((t) => ({ key: t.key, label: t.label, delta: t.delta_pct as number }));

  if (moved.length === 0) {
    return {
      text: 'Predictor accuracy is steady across the script.',
      tone: 'neutral',
    };
  }

  const improved = [...moved].filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  const regressed = [...moved].filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta)[0];

  if (improved && regressed) {
    return {
      text: `${improved.label} predictions are getting sharper (${improved.delta.toFixed(1)}pp); ${regressed.label.toLowerCase()} is drifting (+${regressed.delta.toFixed(1)}pp).`,
      tone: 'neutral',
    };
  }
  if (improved) {
    return {
      text: `${improved.label} predictions are getting sharper (${improved.delta.toFixed(1)}pp MAE shift).`,
      tone: 'positive',
    };
  }
  // regressed only
  return {
    text: `${regressed!.label} predictions are drifting (+${regressed!.delta.toFixed(1)}pp MAE).`,
    tone: 'negative',
  };
}

function formatRelative(iso: string): string | null {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return null;
    const diff = Date.now() - then;
    if (diff < 0) return 'just now';
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  } catch {
    return null;
  }
}
