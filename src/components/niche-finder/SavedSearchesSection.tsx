'use client';

/**
 * "Saved searches" section on the watchlist page.
 *
 * Receives the workspace's saved-search rows as initial props from
 * the server component. Click "Run now" → opens the cross-category
 * search modal with the row's spec pre-applied. The server stamps
 * `last_match_count` + `last_rescored_at` on the row so the next
 * render shows fresh numbers.
 *
 * "Delete" removes the row optimistically; we re-fetch from the
 * server on success to stay correct if multiple tabs are open.
 */
import { useCallback, useState } from 'react';
import type { BrowseFilters } from '@/lib/niche-finder/browse-filters';
import { CrossCategorySearchModal } from './CrossCategorySearchModal';

interface SavedSearchRowProps {
  niche_slug: string;
  search_label: string;
  search_spec: BrowseFilters;
  last_match_count: number | null;
  last_rescored_at: string | null;
  created_at: string;
}

interface SavedSearchesSectionProps {
  initialRows: SavedSearchRowProps[];
  /** Locale for replaying the search. Saved searches don't bind to a
   *  locale at save time — the user's currently-active locale is used.
   *  Defaults match the niche-finder page (en / US). */
  language?: string;
  region?: string;
}

export function SavedSearchesSection({
  initialRows,
  language = 'en',
  region = 'US',
}: SavedSearchesSectionProps): React.ReactElement | null {
  const [rows, setRows] = useState<SavedSearchRowProps[]>(initialRows);
  const [activeSearch, setActiveSearch] = useState<SavedSearchRowProps | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/niche-finder/watchlist/searches');
      if (!res.ok) return;
      const body = (await res.json()) as { rows: SavedSearchRowProps[] };
      setRows(body.rows);
    } catch {
      /* leave the current list */
    }
  }, []);

  const onDelete = useCallback(
    async (slug: string) => {
      if (!confirm('Delete this saved search?')) return;
      setDeleting(slug);
      try {
        // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
        await fetch(`/api/niche-finder/watchlist/searches/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
        });
        await refresh();
      } finally {
        setDeleting(null);
      }
    },
    [refresh],
  );

  if (rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, color: '#e2e8f0' }}>
        Saved searches
      </h2>
      <p style={{ color: '#94a3b8', marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}>
        Filter specs from the Browse Categories tab. <strong>Run now</strong> scans every niche
        you&apos;ve scored across all categories in (en / US) and lists the matches.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.niche_slug}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 12,
              alignItems: 'center',
              padding: 12,
              background: 'rgba(34,197,94,0.04)',
              border: '1px solid rgba(34,197,94,0.20)',
              borderRadius: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{row.search_label}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                {row.last_match_count != null
                  ? `Last run: ${row.last_match_count} match${row.last_match_count === 1 ? '' : 'es'}`
                  : 'Never run'}
                {row.last_rescored_at && ` · ${formatDate(row.last_rescored_at)}`}
                {' · saved '}
                {formatDate(row.created_at)}
              </div>
            </div>
            <button
              onClick={() => setActiveSearch(row)}
              style={{
                padding: '6px 12px',
                background: '#22c55e',
                color: '#0a0e16',
                border: 'none',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Run now
            </button>
            <button
              onClick={() => void onDelete(row.niche_slug)}
              disabled={deleting === row.niche_slug}
              aria-label={`Delete ${row.search_label}`}
              title="Delete saved search"
              style={{
                padding: '6px 10px',
                background: 'transparent',
                color: '#94a3b8',
                border: '1px solid #334155',
                borderRadius: 6,
                fontSize: 12,
                cursor: deleting === row.niche_slug ? 'wait' : 'pointer',
              }}
            >
              {deleting === row.niche_slug ? '…' : '×'}
            </button>
          </div>
        ))}
      </div>

      <CrossCategorySearchModal
        open={activeSearch !== null}
        spec={activeSearch?.search_spec ?? {}}
        language={language}
        region={region}
        searchSlug={activeSearch?.niche_slug}
        title={activeSearch ? `Run: ${activeSearch.search_label}` : undefined}
        onClose={() => {
          setActiveSearch(null);
          // Refetch so last_match_count + last_rescored_at refresh in the list.
          void refresh();
        }}
      />
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}
