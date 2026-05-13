'use client';

/**
 * Scatter view of the filtered sub-niches.
 *
 *   x-axis: demand (low → very high)
 *   y-axis: openness (saturated → wide open) — inverted crowdedness
 *           so the "sweet spot" is the TOP-RIGHT quadrant
 *   color:  RPM tier (low / mid / high)
 *   size:   fit rank (could-work bubbles are larger)
 *
 * The top-right quadrant has a soft green tint to visually anchor the
 * recommended region — first-time operators see "go up and to the
 * right" without reading a tutorial (lazy-user lens, plan §7).
 *
 * Plain inline SVG — the codebase has no chart library and one
 * dedicated dependency for a 90-line scatter is overkill.
 *
 * Hover a bubble for the niche name + headline scores. Click a bubble
 * to surface the matching card below (`onSelect(slug)` bubbles to the
 * parent, which is expected to scroll/highlight).
 */
import { useId } from 'react';
import type { DiscoveryResultItem } from '@/lib/niche-finder/discoveries-db';
import {
  quadrantFit,
  quadrantX,
  quadrantY,
  rpmTier,
} from '@/lib/niche-finder/browse-filters';

interface QuadrantViewProps {
  items: readonly DiscoveryResultItem[];
  /** Currently highlighted slug — drawn with an outline ring. */
  selectedSlug?: string | null;
  onSelect?: (slug: string) => void;
}

/** SVG viewport. Width is flexible (responsive via preserveAspectRatio)
 *  but the aspect ratio is fixed for a predictable axis label layout. */
const VIEW_W = 520;
const VIEW_H = 300;
const PAD_LEFT = 80;
const PAD_RIGHT = 16;
const PAD_TOP = 20;
const PAD_BOTTOM = 56;

const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

/** RPM tier → bubble colour. The green for "high" matches the
 *  active-chip green elsewhere in the niche finder. */
const RPM_COLOUR: Record<ReturnType<typeof rpmTier>, string> = {
  low: '#475569',
  mid: '#60a5fa',
  high: '#22c55e',
};

/** Bubble radius in px. `fit` is 0..1 — map to 4..9px. */
function bubbleRadius(fit: number): number {
  return 4 + Math.max(0, Math.min(1, fit)) * 5;
}

/** Plot coordinate from a 0..1 unit value. */
function plotX(unit: number): number {
  return PAD_LEFT + Math.max(0, Math.min(1, unit)) * PLOT_W;
}

function plotY(unit: number): number {
  // SVG y grows downward, so flip the unit value.
  return PAD_TOP + (1 - Math.max(0, Math.min(1, unit))) * PLOT_H;
}

export function BrowseQuadrantView({
  items,
  selectedSlug,
  onSelect,
}: QuadrantViewProps): React.ReactElement {
  const sweetSpotPatternId = useId();

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: 'center',
          color: '#94a3b8',
          fontSize: 13,
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.10)',
          borderRadius: 12,
        }}
      >
        Nothing to plot. Loosen a filter to see niches on the map.
      </div>
    );
  }

  // Plot the unselected bubbles first, then the selected one on top
  // so its ring isn't covered by an overlapping circle.
  const ordered = items.slice().sort((a, b) => {
    if (a.slug === selectedSlug) return 1;
    if (b.slug === selectedSlug) return -1;
    return 0;
  });

  return (
    <div
      style={{
        padding: 14,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12,
      }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Demand vs. openness scatter of filtered niches"
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <defs>
          <pattern
            id={sweetSpotPatternId}
            patternUnits="userSpaceOnUse"
            width="8"
            height="8"
          >
            <rect width="8" height="8" fill="rgba(34,197,94,0.06)" />
          </pattern>
        </defs>

        {/* Sweet-spot quadrant tint (top-right: demand≥0.5, openness≥0.5) */}
        <rect
          x={plotX(0.5)}
          y={plotY(1)}
          width={PLOT_W / 2}
          height={PLOT_H / 2}
          fill={`url(#${sweetSpotPatternId})`}
        />

        {/* Plot frame */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
        />

        {/* Quadrant midlines */}
        <line
          x1={plotX(0.5)}
          x2={plotX(0.5)}
          y1={PAD_TOP}
          y2={PAD_TOP + PLOT_H}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="2 4"
        />
        <line
          y1={plotY(0.5)}
          y2={plotY(0.5)}
          x1={PAD_LEFT}
          x2={PAD_LEFT + PLOT_W}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="2 4"
        />

        {/* Sweet-spot label */}
        <text
          x={plotX(0.75)}
          y={plotY(0.95)}
          textAnchor="middle"
          fontSize={10}
          fill="rgba(134,239,172,0.7)"
        >
          ← sweet spot
        </text>

        {/* X-axis labels: demand */}
        <text x={plotX(0)} y={VIEW_H - 30} textAnchor="middle" fontSize={10} fill="#64748b">
          low
        </text>
        <text x={plotX(0.33)} y={VIEW_H - 30} textAnchor="middle" fontSize={10} fill="#64748b">
          medium
        </text>
        <text x={plotX(0.66)} y={VIEW_H - 30} textAnchor="middle" fontSize={10} fill="#64748b">
          high
        </text>
        <text x={plotX(1)} y={VIEW_H - 30} textAnchor="middle" fontSize={10} fill="#64748b">
          very high
        </text>
        <text
          x={PAD_LEFT + PLOT_W / 2}
          y={VIEW_H - 12}
          textAnchor="middle"
          fontSize={11}
          fill="#94a3b8"
        >
          Demand →
        </text>

        {/* Y-axis labels: openness (inverted crowdedness) */}
        <text
          x={PAD_LEFT - 8}
          y={plotY(1) + 4}
          textAnchor="end"
          fontSize={10}
          fill="#64748b"
        >
          wide open
        </text>
        <text
          x={PAD_LEFT - 8}
          y={plotY(0.66) + 4}
          textAnchor="end"
          fontSize={10}
          fill="#64748b"
        >
          room
        </text>
        <text
          x={PAD_LEFT - 8}
          y={plotY(0.33) + 4}
          textAnchor="end"
          fontSize={10}
          fill="#64748b"
        >
          crowded
        </text>
        <text
          x={PAD_LEFT - 8}
          y={plotY(0) + 4}
          textAnchor="end"
          fontSize={10}
          fill="#64748b"
        >
          saturated
        </text>
        <text
          transform={`rotate(-90, 16, ${PAD_TOP + PLOT_H / 2})`}
          x={16}
          y={PAD_TOP + PLOT_H / 2}
          textAnchor="middle"
          fontSize={11}
          fill="#94a3b8"
        >
          ← Openness
        </text>

        {/* Bubbles */}
        {ordered.map((item) => {
          const cx = plotX(quadrantX(item.scores));
          const cy = plotY(quadrantY(item.scores));
          const r = bubbleRadius(quadrantFit(item.scores));
          const tier = rpmTier(item.scores);
          const colour = RPM_COLOUR[tier];
          const isSelected = item.slug === selectedSlug;
          return (
            <g
              key={item.slug}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={onSelect ? () => onSelect(item.slug) : undefined}
            >
              <title>
                {`${item.name}\nDemand: ${item.scores.demand.label}\nCrowdedness: ${item.scores.supply.label}\n$/1k: $${item.scores.monetization.lowUsdPerMille.toFixed(0)}–$${item.scores.monetization.highUsdPerMille.toFixed(0)}\nFit: ${item.scores.fit.label}`}
              </title>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={colour}
                fillOpacity={isSelected ? 0.95 : 0.65}
                stroke={isSelected ? '#86efac' : 'rgba(0,0,0,0.4)'}
                strokeWidth={isSelected ? 2 : 1}
              />
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          marginTop: 8,
          fontSize: 11,
          color: '#94a3b8',
        }}
      >
        <LegendDot colour={RPM_COLOUR.high} label="$20+ /1k" />
        <LegendDot colour={RPM_COLOUR.mid} label="$10–20 /1k" />
        <LegendDot colour={RPM_COLOUR.low} label="< $10 /1k" />
        <div style={{ color: '#64748b' }}>Bubble size = fit</div>
      </div>
    </div>
  );
}

function LegendDot({ colour, label }: { colour: string; label: string }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: colour,
          opacity: 0.8,
        }}
      />
      {label}
    </span>
  );
}
