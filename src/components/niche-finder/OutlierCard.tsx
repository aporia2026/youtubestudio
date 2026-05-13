'use client';

/**
 * One video surfaced by the outlier finder (mode D). Shows the
 * thumbnail (with a duration badge), title, view-count, channel
 * name + size, and the outlier score with its classification.
 *
 * The "Check monetization" button at the bottom of the card runs a
 * single watch-page scrape via /api/niche-finder/monetization-check
 * — see _plans/2026-05-13-monetization-on-demand-check.md for why
 * this is lazy on-demand instead of auto-checking every result.
 */
import { useState } from 'react';
import type { OutlierVideo } from '@/lib/niche-finder/outliers';
import { parseDurationToSeconds } from '@/lib/niche-finder/scoring/shared';
import { isLikelyMonetized } from '@/lib/niche-finder/outlier-filters';
import type {
  MonetizationCheckResult,
  MonetizationStatus,
} from '@/lib/niche-finder/monetization-scrape';
import { FavoriteButton } from './FavoriteButton';
import type { FavoriteSourceTab } from '@/lib/niche-finder/favorites';
import type { NicheScores } from '@/lib/niche-finder/types';

const TONE_BG: Record<OutlierVideo['classification'], string> = {
  underperformer: 'rgba(100, 116, 139, 0.10)',
  normal: 'rgba(245, 158, 11, 0.10)',
  breakout: 'rgba(34, 197, 94, 0.12)',
  viral: 'rgba(192, 132, 252, 0.16)',
};
const TONE_BORDER: Record<OutlierVideo['classification'], string> = {
  underperformer: 'rgba(100, 116, 139, 0.30)',
  normal: 'rgba(245, 158, 11, 0.30)',
  breakout: 'rgba(34, 197, 94, 0.40)',
  viral: 'rgba(192, 132, 252, 0.50)',
};

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Format an ISO 8601 video duration as `m:ss` or `h:mm:ss`. Returns
 *  null for missing / unparsable / zero-length input so the caller
 *  can suppress the badge. */
function formatDuration(iso: string): string | null {
  const total = parseDurationToSeconds(iso);
  if (total <= 0) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

const STATUS_TONE: Record<MonetizationStatus, { fg: string; bg: string; border: string; label: string }> = {
  monetized: {
    fg: '#86efac',
    bg: 'rgba(34,197,94,0.12)',
    border: 'rgba(34,197,94,0.40)',
    label: 'Monetized',
  },
  'not-monetized': {
    fg: '#cbd5e1',
    bg: 'rgba(100,116,139,0.10)',
    border: 'rgba(100,116,139,0.30)',
    label: 'Not monetized',
  },
  unknown: {
    fg: '#fbbf24',
    bg: 'rgba(245,158,11,0.10)',
    border: 'rgba(245,158,11,0.30)',
    label: 'Unknown',
  },
};

interface OutlierCardProps {
  video: OutlierVideo;
  /** Which tab the card is rendered on. Stamped on the favorite if
   *  the operator hearts it. Defaults to 'outliers' since that's the
   *  primary host today. */
  sourceTab?: FavoriteSourceTab;
  /** When the surrounding tab knows which niche these outliers came
   *  from, pass it here. Favoriting a video then auto-attaches under
   *  this niche (the hybrid niche-assignment heuristic). When null,
   *  the FavoriteButton opens the picker modal. */
  activeNicheContext?: {
    slug: string;
    name: string;
    scores: NicheScores;
  } | null;
}

export function OutlierCard({
  video,
  sourceTab = 'outliers',
  activeNicheContext = null,
}: OutlierCardProps): React.ReactElement {
  const duration = formatDuration(video.durationIso);
  const likelyMonet = isLikelyMonetized({
    subscriberCount: video.subscriberCount,
    durationIso: video.durationIso,
  });
  const [monet, setMonet] = useState<MonetizationCheckResult | null>(null);
  const [monetLoading, setMonetLoading] = useState(false);
  const [monetError, setMonetError] = useState<string | null>(null);

  async function checkMonetization(e: React.MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (monetLoading) return;
    setMonetLoading(true);
    setMonetError(null);
    try {
      const res = await fetch('/api/niche-finder/monetization-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: video.videoId, forceRefresh: !!monet }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMonetError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as MonetizationCheckResult;
      setMonet(data);
    } catch (err) {
      setMonetError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setMonetLoading(false);
    }
  }

  return (
    <a
      href={`https://www.youtube.com/watch?v=${video.videoId}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block',
        textDecoration: 'none',
        border: `1px solid ${TONE_BORDER[video.classification]}`,
        background: TONE_BG[video.classification],
        borderRadius: 10,
        padding: 12,
        color: '#e2e8f0',
      }}
    >
      <div style={{ display: 'flex', gap: 12 }}>
        {video.thumbnailUrl && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={video.thumbnailUrl}
              alt=""
              width={120}
              height={68}
              style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 6, display: 'block' }}
            />
            {duration && (
              <span
                style={{
                  position: 'absolute',
                  right: 4,
                  bottom: 4,
                  background: 'rgba(0,0,0,0.82)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 5px',
                  borderRadius: 3,
                  lineHeight: 1.2,
                  letterSpacing: 0.2,
                }}
              >
                {duration}
              </span>
            )}
            <div style={{ position: 'absolute', top: 4, right: 4 }}>
              <FavoriteButton
                kind="video"
                video={{
                  videoId: video.videoId,
                  channelId: video.channelId,
                  title: video.title,
                  thumbnailUrl: video.thumbnailUrl,
                  viewCount: video.viewCount,
                  publishedAt: video.publishedAt,
                  outlierScore: video.outlierScore,
                  classification: video.classification,
                  durationIso: video.durationIso,
                  channelTitle: video.channelTitle,
                  subscriberCount: video.subscriberCount,
                }}
                activeNicheContext={
                  activeNicheContext
                    ? { ...activeNicheContext, sourceTab }
                    : null
                }
                sourceTab={sourceTab}
                variant="overlay"
              />
            </div>
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              lineHeight: 1.3,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
            title={video.title}
          >
            {video.title}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
            {video.channelTitle} · {compactNumber(video.subscriberCount)} subs
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            {compactNumber(video.viewCount)} views ·{' '}
            <span
              style={{
                color:
                  video.classification === 'viral'
                    ? '#c084fc'
                    : video.classification === 'breakout'
                      ? '#22c55e'
                      : video.classification === 'normal'
                        ? '#f59e0b'
                        : '#64748b',
                fontWeight: 600,
              }}
            >
              {video.outlierScore.toFixed(1)}× ({video.classification})
            </span>
            {!monet && (
              <span
                title={
                  likelyMonet
                    ? 'Heuristic: channel meets the YPP minimum (≥1K subs) and the video clears the mid-roll floor (≥8 min). Click "Check monetization" for the verified answer.'
                    : 'Heuristic: channel below YPP minimum (1K subs) and/or video below the mid-roll floor (8 min). Click "Check monetization" for the verified answer.'
                }
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  color: likelyMonet ? '#86efac' : '#94a3b8',
                  fontStyle: 'italic',
                }}
              >
                · {likelyMonet ? 'Likely monetized' : 'Likely not monetized'}
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {monet ? (
              <MonetizationPill
                status={monet.status}
                reason={monet.reason}
                cached={monet.cached}
                onRecheck={checkMonetization}
                loading={monetLoading}
              />
            ) : (
              <button
                type="button"
                onClick={checkMonetization}
                disabled={monetLoading}
                title="Fetches the YouTube watch page and parses ad placements. The API doesn't publish monetization status directly — this is a one-off scrape, cached for 7 days."
                style={{
                  padding: '3px 8px',
                  background: 'transparent',
                  color: monetLoading ? '#475569' : '#94a3b8',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: monetLoading ? 'wait' : 'pointer',
                }}
              >
                {monetLoading ? 'Checking…' : 'Check monetization'}
              </button>
            )}
            {monetError && (
              <span style={{ fontSize: 11, color: '#f87171' }} title={monetError}>
                Check failed
              </span>
            )}
          </div>
        </div>
      </div>
    </a>
  );
}

function MonetizationPill({
  status,
  reason,
  cached,
  onRecheck,
  loading,
}: {
  status: MonetizationStatus;
  reason: string;
  cached: boolean;
  onRecheck: (e: React.MouseEvent) => void;
  loading: boolean;
}): React.ReactElement {
  const tone = STATUS_TONE[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      <span
        title={reason}
        style={{
          padding: '2px 8px',
          background: tone.bg,
          color: tone.fg,
          border: `1px solid ${tone.border}`,
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {tone.label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: '#64748b',
          fontStyle: 'italic',
        }}
      >
        {reason}
        {cached && ' (cached)'}
      </span>
      <button
        type="button"
        onClick={onRecheck}
        disabled={loading}
        title="Re-check (skips the 7-day cache)"
        aria-label="Re-check monetization"
        style={{
          padding: '1px 6px',
          background: 'transparent',
          color: loading ? '#475569' : '#64748b',
          border: '1px solid transparent',
          borderRadius: 4,
          fontSize: 10,
          cursor: loading ? 'wait' : 'pointer',
        }}
      >
        {loading ? '…' : '↻'}
      </button>
    </span>
  );
}
