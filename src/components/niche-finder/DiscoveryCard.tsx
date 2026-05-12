'use client';

/**
 * One niche surfaced by an A/B/C discovery. Shows the four
 * plain-English scores + a "Deep dive" button that runs the v0.5
 * orchestrator and navigates to the persisted-report page.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NicheScores } from '@/lib/niche-finder/types';

interface DiscoveryCardProps {
  slug: string;
  name: string;
  rationale?: string;
  scores: NicheScores;
}

export function DiscoveryCard({ slug, name, rationale, scores }: DiscoveryCardProps): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

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
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.02)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0' }}>{name}</div>
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

      <button
        onClick={onDeepDive}
        disabled={busy}
        style={{
          marginTop: 4,
          padding: '8px 14px',
          background: busy ? '#1e293b' : '#22c55e',
          color: busy ? '#64748b' : '#0a0e16',
          border: 'none',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: busy ? 'not-allowed' : 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        {busy ? 'Generating…' : 'Deep dive →'}
      </button>
    </div>
  );
}
