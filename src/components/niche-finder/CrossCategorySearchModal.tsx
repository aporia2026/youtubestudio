'use client';

/**
 * Modal that runs the current filter spec across every cached
 * taxonomy node in the workspace + locale and lists the best matches.
 *
 * Pure cached-data read (POST /api/niche-finder/taxonomy/search) — no
 * YouTube quota, no AI calls. Match count is workspace-scoped; matches
 * appear from any category the operator has previously drilled into
 * (whose scores live in `niche_taxonomy_scores`).
 *
 * Used in two places:
 *   - CategoryTab on the niche finder → opens with the operator's
 *     current dial set
 *   - Watchlist page "Run now" on a saved search → opens with the
 *     saved spec; passes `searchSlug` so the server stamps last-run
 *     count + timestamp for the row
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BrowseFilters } from '@/lib/niche-finder/browse-filters';
import type { NicheScores } from '@/lib/niche-finder/types';

interface MatchPayload {
  nodeId: string;
  slug: string;
  name: string;
  level: 'subniche' | 'microniche';
  rationale: string | null;
  path: string[];
  scores: NicheScores;
  sampleSize: number;
  scoredAt: string;
}

interface SearchResponse {
  matches: MatchPayload[];
  totalCached: number;
  totalMatching: number;
  language: string;
  region: string;
}

interface CrossCategorySearchModalProps {
  open: boolean;
  spec: BrowseFilters;
  language: string;
  region: string;
  /** Optional — when running a saved search, stamps last_match_count on
   *  the row so the watchlist UI can show fresh numbers. */
  searchSlug?: string;
  /** Optional label for the modal title (e.g. saved-search name). */
  title?: string;
  onClose: () => void;
}

export function CrossCategorySearchModal({
  open,
  spec,
  language,
  region,
  searchSlug,
  title,
  onClose,
}: CrossCategorySearchModalProps): React.ReactElement | null {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const router = useRouter();

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/niche-finder/taxonomy/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec,
          language,
          region,
          searchSlug: searchSlug ?? undefined,
          limit: 50,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Could not run this search.');
        return;
      }
      setResults(body as SearchResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [language, region, searchSlug, spec]);

  useEffect(() => {
    if (open) void runSearch();
  }, [open, runSearch]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onDeepDive = useCallback(
    async (match: MatchPayload) => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
        const res = await fetch('/api/niche-finder/deep-dive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nicheText: match.name }),
        });
        if (!res.ok) return;
        router.push(`/insights/niches/${match.slug}`);
      } catch {
        /* swallow — surface via the existing error state next render */
      }
    },
    [router],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '60px 24px 24px',
        zIndex: 100,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 760,
          background: '#0d0d14',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 12,
          padding: 20,
          color: '#e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxHeight: 'calc(100vh - 80px)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
              {title ?? 'Sweet spot across all categories'}
            </h2>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
              Searching every niche you&apos;ve scored in <strong>{language}</strong> /{' '}
              <strong>{region}</strong>.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: '1px solid #334155',
              color: '#cbd5e1',
              padding: '4px 10px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        {/* Status */}
        {loading && (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>
            Scanning cached scores…
          </div>
        )}
        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}

        {results && (
          <>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {results.totalMatching} match{results.totalMatching === 1 ? '' : 'es'} out of{' '}
              {results.totalCached} scored niche{results.totalCached === 1 ? '' : 's'}.
              {results.totalMatching === 0 && results.totalCached === 0 && (
                <span style={{ color: '#94a3b8' }}>
                  {' '}You haven&apos;t scored any niches in this locale yet. Drill into a category first to build up the
                  cache.
                </span>
              )}
            </div>

            {results.matches.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  overflowY: 'auto',
                  paddingRight: 4,
                }}
              >
                {results.matches.map((m) => (
                  <MatchRow key={m.nodeId} match={m} onDeepDive={() => void onDeepDive(m)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MatchRow({
  match,
  onDeepDive,
}: {
  match: MatchPayload;
  onDeepDive: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: 12,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          {match.path.length > 0 ? match.path.join(' › ') : 'Root'}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{match.name}</div>
        <div
          style={{
            fontSize: 11,
            color: '#94a3b8',
            marginTop: 4,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <span>
            <span style={{ color: '#64748b' }}>Demand:</span> {match.scores.demand.label}
          </span>
          <span>
            <span style={{ color: '#64748b' }}>Crowdedness:</span> {match.scores.supply.label}
          </span>
          <span>
            <span style={{ color: '#64748b' }}>$/1k:</span> $
            {match.scores.monetization.lowUsdPerMille.toFixed(0)}–$
            {match.scores.monetization.highUsdPerMille.toFixed(0)}
          </span>
          <span>
            <span style={{ color: '#64748b' }}>Fit:</span> {match.scores.fit.label}
          </span>
        </div>
      </div>
      <button
        onClick={onDeepDive}
        style={{
          padding: '8px 14px',
          background: '#22c55e',
          color: '#0a0e16',
          border: 'none',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Deep dive →
      </button>
    </div>
  );
}
