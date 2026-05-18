'use client';

/**
 * One niche surfaced by an A/B/C discovery. Shows the four
 * plain-English scores + a "Deep dive" button that runs the v0.5
 * orchestrator and navigates to the persisted-report page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NicheScores } from '@/lib/niche-finder/types';
import { isSweetSpot } from '@/lib/niche-finder/browse-filters';
import { FavoriteButton } from './FavoriteButton';
import type { FavoriteSourceTab } from '@/lib/niche-finder/favorites';

interface DiscoveryCardProps {
  slug: string;
  name: string;
  rationale?: string;
  scores: NicheScores;
  /** Which tab the operator was on when this card was rendered.
   *  Stamped on the favorite row if they heart it. */
  sourceTab: FavoriteSourceTab;
  /** When true, the card pulses + outlines green and scrolls itself
   *  into view. Used by the Browse quadrant chart so clicking a bubble
   *  surfaces the matching card. */
  highlighted?: boolean;
  /** When provided, adds a "Drill in →" action beside "Deep dive".
   *  Used by the hierarchical Browse Categories flow at the sub-niche
   *  level — clicking drills into the sub-niche's micro-niches.
   *  Omitted at the micro-niche (leaf) level. */
  onDrill?: () => void;
  /** When true, the card is rendered dimmed with a "doesn't match
   *  filter" badge. Used in Browse Categories so scored sub-niches
   *  that fail the active filter stay visible instead of vanishing
   *  out of the grid — the operator can still see what exists and
   *  decide whether to loosen the filter. */
  dimmed?: boolean;
}

export function DiscoveryCard({
  slug,
  name,
  rationale,
  scores,
  sourceTab,
  highlighted = false,
  onDrill,
  dimmed = false,
}: DiscoveryCardProps): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const sweetSpot = isSweetSpot(scores);

  useEffect(() => {
    if (highlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted]);

  const onDeepDive = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/niche-finder/deep-dive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nicheText: name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Deep-dive failed: ${(body as { error?: string }).error ?? res.status}`);
        return;
      }
      router.push(`/insights/niches/${slug}`);
    } finally {
      setBusy(false);
    }
  }, [busy, name, router, slug]);

  return (
    <div
      ref={cardRef}
      style={{
        border: highlighted
          ? '1px solid #22c55e'
          : sweetSpot
            ? '1px solid rgba(34,197,94,0.35)'
            : '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        background: highlighted
          ? 'rgba(34,197,94,0.08)'
          : sweetSpot
            ? 'rgba(34,197,94,0.03)'
            : 'rgba(255,255,255,0.02)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'background 0.2s, border-color 0.2s, opacity 0.2s',
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', flex: 1, minWidth: 0 }}>{name}</div>
          {sweetSpot && (
            <span
              title="High demand, room to enter, and ≥ $10 per 1k views"
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                color: '#86efac',
                background: 'rgba(34,197,94,0.12)',
                border: '1px solid rgba(34,197,94,0.4)',
                padding: '2px 6px',
                borderRadius: 4,
                textTransform: 'uppercase',
              }}
            >
              Sweet spot
            </span>
          )}
          {dimmed && (
            <span
              title="This niche doesn't match the active filter. Loosen the filter or pick a different preset to bring it back."
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                color: '#94a3b8',
                background: 'rgba(148,163,184,0.10)',
                border: '1px solid rgba(148,163,184,0.30)',
                padding: '2px 6px',
                borderRadius: 4,
                textTransform: 'uppercase',
              }}
            >
              Filtered out
            </span>
          )}
          <FavoriteButton
            kind="niche"
            slug={slug}
            name={name}
            scores={scores}
            sourceTab={sourceTab}
            variant="inline"
          />
        </div>
        {rationale && (
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, lineHeight: 1.4 }}>{rationale}</div>
        )}
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 12, margin: 0 }}>
        <dt style={{ color: '#64748b' }}>Demand</dt>
        <dd style={{ color: '#cbd5e1', margin: 0 }}>{scores.demand.label}</dd>
        <dt style={{ color: '#64748b' }}>Crowdedness</dt>
        <dd style={{ color: '#cbd5e1', margin: 0 }}>{scores.supply.label}</dd>
        <dt style={{ color: '#64748b' }}>Per 1k views</dt>
        <dd style={{ color: '#cbd5e1', margin: 0 }}>
          ${scores.monetization.lowUsdPerMille.toFixed(0)}–${scores.monetization.highUsdPerMille.toFixed(0)}
        </dd>
        <dt style={{ color: '#64748b' }}>Fit</dt>
        <dd style={{ color: '#cbd5e1', margin: 0 }}>{scores.fit.label}</dd>
      </dl>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        <button
          onClick={onDeepDive}
          disabled={busy}
          style={{
            padding: '8px 14px',
            background: busy ? '#1e293b' : '#22c55e',
            color: busy ? '#64748b' : '#0a0e16',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Generating…' : 'Deep dive →'}
        </button>
        {onDrill && (
          <button
            onClick={onDrill}
            disabled={busy}
            title="Browse the micro-niches inside this one"
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Drill in →
          </button>
        )}
      </div>
    </div>
  );
}
