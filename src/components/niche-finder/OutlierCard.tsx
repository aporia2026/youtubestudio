'use client';

/**
 * One video surfaced by the outlier finder (mode D). Shows the
 * thumbnail, title, view-count, channel name + size, and the
 * outlier score with its classification.
 */
import type { OutlierVideo } from '@/lib/niche-finder/outliers';

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

export function OutlierCard({ video }: { video: OutlierVideo }): React.ReactElement {
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
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnailUrl}
            alt=""
            width={120}
            height={68}
            style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
          />
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
          </div>
        </div>
      </div>
    </a>
  );
}
