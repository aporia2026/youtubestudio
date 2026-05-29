'use client';

/**
 * Compare overlay — side-by-side view of 2-3 selected favorites.
 *
 * Per the plan §9.4: each selected favorite becomes a column; rows
 * align by Promise score / Demand / Crowdedness / Monetization / Fit /
 * Headline / Operator fit / Recommended angle / Risks. The
 * highest-scoring cell in each comparable row gets a subtle green
 * outline so the operator can spot the leader at a glance.
 *
 * Briefs are fetched in parallel on mount. Each column polls
 * independently (re-uses the same /brief endpoint), so if the
 * operator opens Compare right after kicking off a regenerate they
 * see the new brief land in place.
 *
 * "Export comparison" calls /favorites/export-compare-sheet and opens
 * the returned URL in a new tab — the comparison lives on as a
 * shareable artifact.
 */
import { useEffect, useMemo, useState } from 'react';
import type { NicheFavoriteWithVideos } from '@/lib/niche-finder/favorites';
import { isPlaceholderScores } from '@/lib/niche-finder/favorites';
import type { BriefRow } from '@/lib/niche-finder/brief-db';
import { getModelById } from '@/lib/ai-models';

interface CompareOverlayProps {
  favorites: NicheFavoriteWithVideos[];
  onClose: () => void;
}

interface BriefResponse {
  active: BriefRow | null;
  latest: BriefRow | null;
  history: BriefRow[];
}

export function CompareOverlay({ favorites, onClose }: CompareOverlayProps): React.ReactElement {
  const [briefs, setBriefs] = useState<(BriefRow | null)[]>(() => favorites.map(() => null));
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const results = await Promise.all(
          favorites.map(async (f) => {
            try {
              // eslint-disable-next-line no-restricted-syntax -- GET, read
              const res = await fetch(
                `/api/niche-finder/favorites/${encodeURIComponent(f.niche_slug)}/brief`,
              );
              if (!res.ok) return null;
              const body = (await res.json()) as BriefResponse;
              return body.active ?? null;
            } catch {
              return null;
            }
          }),
        );
        if (!cancelled) setBriefs(results);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [favorites]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !exporting) onClose();
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [exporting, onClose]);

  // Best-cell highlights — for each comparable numeric row, find the
  // column whose value is the max (or best label). We do this for
  // Promise score + per-1k monetization range. Verbal score chips
  // (demand/crowdedness/fit) get qualitative best-label detection.
  const highlights = useMemo(
    () => computeHighlights(favorites, briefs),
    [favorites, briefs],
  );

  async function onExport() {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/niche-finder/favorites/export-compare-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: favorites.map((f) => f.niche_slug) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        const code = body?.error ?? '';
        const msg = body?.message ?? body?.error ?? `Export failed (${res.status})`;
        if (code === 'NEEDS_GOOGLE_AUTH' || code === 'NEEDS_REAUTH') {
          setError(`${msg} Open Settings → Google Account.`);
        } else {
          setError(msg);
        }
        return;
      }
      const body = (await res.json()) as { sheetUrl?: string };
      if (body.sheetUrl) {
        window.open(body.sheetUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compare favorites"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0d0d14',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 14,
          width: '100%',
          maxWidth: 1180,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Compare favorites
            </div>
            <div style={{ fontSize: 16, color: '#e2e8f0', fontWeight: 600, marginTop: 2 }}>
              {favorites.map((f) => f.niche_name).join(' · ')}
            </div>
          </div>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            style={{
              padding: '7px 14px',
              background: exporting ? '#1e293b' : '#22c55e',
              color: exporting ? '#64748b' : '#0a0e16',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: exporting ? 'wait' : 'pointer',
            }}
          >
            {exporting ? 'Exporting…' : 'Export comparison (Sheets)'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#64748b',
              fontSize: 22,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
              marginLeft: 4,
            }}
          >
            ×
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(248,113,113,0.08)',
              borderBottom: '1px solid rgba(248,113,113,0.20)',
              color: '#fca5a5',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* Body — column grid */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px 18px',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `160px repeat(${favorites.length}, minmax(220px, 1fr))`,
              gap: '4px 12px',
              alignItems: 'start',
            }}
          >
            <RowLabel value="" />
            {favorites.map((f) => (
              <div
                key={f.niche_slug}
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#e2e8f0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={f.niche_name}
              >
                {f.niche_name}
              </div>
            ))}

            <CompareRow
              label="Promise"
              values={favorites.map((f, i) => {
                const b = briefs[i];
                if (!b) return loading ? '…' : '—';
                return `${b.promise_score}/100 (${b.promise_label})`;
              })}
              highlightIndexes={highlights.promise}
            />
            <CompareRow
              label="Status"
              values={favorites.map((f) => statusLabel(f.status))}
            />
            <CompareRow
              label="Verdict"
              values={favorites.map((f) => f.verdict ?? '—')}
            />
            <CompareRow
              label="Outcome"
              values={favorites.map((f) => f.outcome ?? '—')}
            />
            <CompareRow
              label="Demand"
              values={favorites.map((f) => (isPlaceholderScores(f.scores) ? '—' : f.scores.demand.label))}
              highlightIndexes={highlights.demand}
            />
            <CompareRow
              label="Crowdedness"
              values={favorites.map((f) => (isPlaceholderScores(f.scores) ? '—' : f.scores.supply.label))}
              highlightIndexes={highlights.crowdedness}
            />
            <CompareRow
              label="Per 1k views"
              values={favorites.map((f) => moneyRange(f))}
              highlightIndexes={highlights.monetization}
            />
            <CompareRow
              label="Fit"
              values={favorites.map((f) => (isPlaceholderScores(f.scores) ? '—' : f.scores.fit.label))}
              highlightIndexes={highlights.fit}
            />
            <CompareRow
              label="Videos saved"
              values={favorites.map((f) => String(f.videos.filter((v) => !v.is_removed_upstream).length))}
            />
            <CompareSectionRow label="Headline" values={favorites.map((_, i) => briefs[i]?.sections.headline ?? (loading ? 'Loading brief…' : 'No brief yet'))} />
            <CompareSectionRow label="Operator fit" values={favorites.map((_, i) => briefs[i]?.sections.operator_fit ?? '')} />
            <CompareSectionRow label="Recommended angle" values={favorites.map((_, i) => briefs[i]?.sections.recommended_angle ?? '')} />
            <CompareSectionRow label="Risks" values={favorites.map((_, i) => briefs[i]?.sections.risks ?? '')} />
            <CompareSectionRow
              label="Brief model"
              values={favorites.map((_, i) => {
                const b = briefs[i];
                if (!b) return '';
                return getModelById(b.model_id)?.name ?? b.model_id;
              })}
            />
          </div>

          {loading && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
              Loading briefs…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components.
// ---------------------------------------------------------------------------

function RowLabel({ value }: { value: string }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: '#64748b',
        fontWeight: 600,
        paddingTop: 8,
      }}
    >
      {value}
    </div>
  );
}

function CompareRow({
  label,
  values,
  highlightIndexes,
}: {
  label: string;
  values: string[];
  /** Column indexes that get the green "leader" outline. Multiple
   *  allowed for ties. */
  highlightIndexes?: number[];
}): React.ReactElement {
  return (
    <>
      <RowLabel value={label} />
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.02)',
            border: highlightIndexes?.includes(i)
              ? '1px solid rgba(34,197,94,0.55)'
              : '1px solid rgba(255,255,255,0.06)',
            fontSize: 13,
            color: '#e2e8f0',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 30,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {v}
          </span>
          {highlightIndexes?.includes(i) && (
            <span style={{ fontSize: 10, color: '#86efac' }} title="Best in this row">
              ★
            </span>
          )}
        </div>
      ))}
    </>
  );
}

function CompareSectionRow({
  label,
  values,
}: {
  label: string;
  values: string[];
}): React.ReactElement {
  return (
    <>
      <RowLabel value={label} />
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            fontSize: 12,
            color: v ? '#cbd5e1' : '#64748b',
            lineHeight: 1.5,
            minHeight: 60,
            whiteSpace: 'pre-wrap',
          }}
        >
          {v || '—'}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function moneyRange(f: NicheFavoriteWithVideos): string {
  if (isPlaceholderScores(f.scores)) return '—';
  const lo = f.scores.monetization.lowUsdPerMille;
  const hi = f.scores.monetization.highUsdPerMille;
  if (lo === 0 && hi === 0) return '—';
  return `$${lo.toFixed(0)}–$${hi.toFixed(0)}`;
}

interface Highlights {
  promise: number[];
  demand: number[];
  crowdedness: number[];
  monetization: number[];
  fit: number[];
}

const DEMAND_RANK: Record<string, number> = {
  'very high': 4,
  high: 3,
  medium: 2,
  low: 1,
};

const SUPPLY_RANK: Record<string, number> = {
  'wide open': 4,
  'room to enter': 3,
  crowded: 2,
  saturated: 1,
};

const FIT_RANK: Record<string, number> = {
  'strong fit': 3,
  'could work': 2,
  'not for you': 1,
};

function bestIndexes(values: ReadonlyArray<number | null>): number[] {
  let best = -Infinity;
  for (const v of values) {
    if (v != null && v > best) best = v;
  }
  if (best === -Infinity) return [];
  const out: number[] = [];
  values.forEach((v, i) => {
    if (v != null && v === best) out.push(i);
  });
  return out;
}

function computeHighlights(
  favorites: NicheFavoriteWithVideos[],
  briefs: (BriefRow | null)[],
): Highlights {
  const promiseScores = briefs.map((b) => (b ? b.promise_score : null));
  const demand = favorites.map((f) =>
    isPlaceholderScores(f.scores) ? null : DEMAND_RANK[f.scores.demand.label] ?? null,
  );
  const crowdedness = favorites.map((f) =>
    isPlaceholderScores(f.scores) ? null : SUPPLY_RANK[f.scores.supply.label] ?? null,
  );
  const monetization = favorites.map((f) =>
    isPlaceholderScores(f.scores)
      ? null
      : (f.scores.monetization.lowUsdPerMille + f.scores.monetization.highUsdPerMille) / 2,
  );
  const fit = favorites.map((f) =>
    isPlaceholderScores(f.scores) ? null : FIT_RANK[f.scores.fit.label] ?? null,
  );

  return {
    promise: bestIndexes(promiseScores),
    demand: bestIndexes(demand),
    crowdedness: bestIndexes(crowdedness),
    monetization: bestIndexes(monetization),
    fit: bestIndexes(fit),
  };
}
