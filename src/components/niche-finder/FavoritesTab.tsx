'use client';

/**
 * Favorites tab — the operator's shortlist of niches under production
 * consideration.
 *
 * One panel per favorite niche, ordered by most-recently-touched. Each
 * panel surfaces: name + status pipeline pill, score chips (or
 * "scores pending" if the niche was added without a deep-dive), the
 * AI-written Niche Brief (PR2), proof-video thumbnails, the operator's
 * notes (autosaved), and the verdict / outcome dropdowns that feed
 * the future retrospective.
 *
 * Sheets export + Compare view land in PR3.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyOptimisticFavorite,
  applyOptimisticUnfavorite,
  invalidateFavoritesIndex,
  useFavoritesIndex,
} from '@/lib/niche-finder/favorites-client';
import {
  isPlaceholderScores,
  isValidStatus,
  type FavoriteOutcome,
  type FavoriteStatus,
  type FavoriteVerdict,
  type NicheFavoriteRow,
  type NicheFavoriteVideoRow,
  type NicheFavoriteWithVideos,
} from '@/lib/niche-finder/favorites';
import { exportFavoritesCSV, exportSingleFavoriteCSV } from '@/lib/niche-finder/favorites-export';
import { NicheBriefCard } from './NicheBriefCard';
import { NicheFinderModelPicker } from './NicheFinderModelPicker';
import { CompareOverlay } from './CompareOverlay';

/** Max simultaneous Compare picks. Aligns with the plan §9.4 "2-3 niches" cap. */
const COMPARE_MAX = 3;

type StatusFilter = 'all' | FavoriteStatus;
type SortKey = 'recent' | 'name';

const STATUS_LABELS: Record<FavoriteStatus, string> = {
  considering: 'Considering',
  committed: 'Committed',
  parked: 'Parked',
  passed: 'Passed',
};
const STATUS_COLORS: Record<FavoriteStatus, string> = {
  considering: '#fbbf24',
  committed: '#22c55e',
  parked: '#94a3b8',
  passed: '#64748b',
};

const VERDICT_LABELS: Record<FavoriteVerdict, string> = {
  accept: 'Accept brief',
  override: 'Override',
  reject: 'Reject brief',
};

const OUTCOME_LABELS: Record<FavoriteOutcome, string> = {
  producing: 'Producing now',
  produced: 'Produced',
  parked: 'Parked',
  killed: 'Killed',
};

export function FavoritesTab(): React.ReactElement {
  const { index, loading, refresh } = useFavoritesIndex();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [exportingSheet, setExportingSheet] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Toggle a niche in / out of the Compare selection. Max COMPARE_MAX;
  // a 4th click is a no-op (the button below also disables itself).
  const toggleCompare = useCallback((slug: string) => {
    setCompareSelection((cur) => {
      if (cur.includes(slug)) return cur.filter((s) => s !== slug);
      if (cur.length >= COMPARE_MAX) return cur;
      return [...cur, slug];
    });
  }, []);

  // When favorites get removed, drop their slugs from the selection so
  // a stale slug can't open the modal.
  useEffect(() => {
    setCompareSelection((cur) => cur.filter((s) => index.bySlug.has(s)));
  }, [index]);

  const selectedFavorites = useMemo(
    () => compareSelection.map((s) => index.bySlug.get(s)).filter((f): f is NonNullable<typeof f> => !!f),
    [compareSelection, index],
  );

  // Top-bar "Export all (Sheets)" — calls the all-favorites endpoint
  // and opens the resulting URL in a new tab. Errors land in the
  // shared exportError state for the inline banner.
  const onExportAllSheet = useCallback(async () => {
    if (exportingSheet || index.favorites.length === 0) return;
    setExportingSheet(true);
    setExportError(null);
    try {
      const res = await fetch('/api/niche-finder/favorites/export-sheet', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        const code = body?.error ?? '';
        const msg = body?.message ?? body?.error ?? `Export failed (${res.status})`;
        if (code === 'NEEDS_GOOGLE_AUTH' || code === 'NEEDS_REAUTH') {
          setExportError(`${msg} Open Settings → Google Account to reconnect.`);
        } else {
          setExportError(msg);
        }
        return;
      }
      const body = (await res.json()) as { sheetUrl?: string };
      if (body.sheetUrl) {
        window.open(body.sheetUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setExportingSheet(false);
    }
  }, [exportingSheet, index.favorites.length]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = index.favorites;
    if (statusFilter !== 'all') list = list.filter((f) => f.status === statusFilter);
    if (q.length > 0) {
      list = list.filter((f) =>
        `${f.niche_name} ${f.niche_slug} ${f.notes ?? ''}`.toLowerCase().includes(q),
      );
    }
    if (sort === 'name') {
      list = [...list].sort((a, b) => a.niche_name.localeCompare(b.niche_name));
    } else {
      list = [...list].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    }
    return list;
  }, [index.favorites, search, statusFilter, sort]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: index.favorites.length,
      considering: 0, committed: 0, parked: 0, passed: 0,
    };
    for (const f of index.favorites) c[f.status]++;
    return c;
  }, [index.favorites]);

  if (loading && index.favorites.length === 0) {
    return (
      <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>Loading favorites…</div>
    );
  }

  if (index.favorites.length === 0) {
    return <EmptyState />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Top bar: two rows — filters + brief controls. */}
      <div
        style={{
          padding: '12px 14px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <input
            type="text"
            placeholder={`Search ${index.favorites.length} favorite${index.favorites.length === 1 ? '' : 's'}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: '1 1 220px',
              minWidth: 0,
              padding: '6px 10px',
              background: '#0f172a',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: 6,
              fontSize: 13,
              outline: 'none',
            }}
          />
          <StatusChips value={statusFilter} counts={counts} onChange={setStatusFilter} />
          <SortDropdown value={sort} onChange={setSort} />
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setCompareOpen(true)}
            disabled={compareSelection.length < 2}
            title={
              compareSelection.length < 2
                ? 'Select 2 or 3 favorites to compare them side by side'
                : `Compare ${compareSelection.length} selected favorite${compareSelection.length === 1 ? '' : 's'}`
            }
            style={{
              ...pillBtn(compareSelection.length >= 2 ? '#22c55e' : '#1e293b'),
              color: compareSelection.length >= 2 ? '#86efac' : '#475569',
              cursor: compareSelection.length >= 2 ? 'pointer' : 'not-allowed',
            }}
          >
            Compare ({compareSelection.length}/{COMPARE_MAX})
          </button>
          <button
            type="button"
            onClick={() => exportFavoritesCSV(index.favorites)}
            style={pillBtn('#334155')}
            title="Download every favorite as a CSV file"
          >
            Export all (CSV)
          </button>
          <button
            type="button"
            onClick={() => void onExportAllSheet()}
            disabled={exportingSheet}
            style={pillBtn('#334155')}
            title="Open every favorite in a new Google Sheet (Summary + Briefs + Proof Videos sheets, with thumbnails and a glossary footer)"
          >
            {exportingSheet ? 'Exporting…' : 'Export all (Sheets)'}
          </button>
        </div>
        {exportError && (
          <div
            style={{
              padding: '8px 10px',
              fontSize: 12,
              color: '#fca5a5',
              background: 'rgba(248,113,113,0.08)',
              border: '1px solid rgba(248,113,113,0.20)',
              borderRadius: 8,
            }}
          >
            {exportError}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            paddingTop: 8,
            borderTop: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <NicheFinderModelPicker feature="niche-favorite-brief" label="Brief model" />
          <div style={{ flex: 1 }} />
          <MonthlyBriefSpendCaption refreshKey={index.favorites.length} />
        </div>
      </div>

      {/* Niche panels */}
      {filtered.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          No favorites match these filters.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((f) => (
            <FavoritePanel
              key={f.niche_slug}
              favorite={f}
              onChanged={refresh}
              compareSelected={compareSelection.includes(f.niche_slug)}
              compareDisabled={
                !compareSelection.includes(f.niche_slug) && compareSelection.length >= COMPARE_MAX
              }
              onToggleCompare={() => toggleCompare(f.niche_slug)}
            />
          ))}
        </div>
      )}

      <RecentlyRemovedSection onRestore={refresh} />

      {compareOpen && selectedFavorites.length >= 2 && (
        <CompareOverlay
          favorites={selectedFavorites}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(): React.ReactElement {
  return (
    <div
      style={{
        marginTop: 12,
        padding: '40px 24px',
        textAlign: 'center',
        border: '1px dashed rgba(255,255,255,0.10)',
        borderRadius: 14,
        background: 'rgba(255,255,255,0.02)',
        color: '#94a3b8',
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>♥</div>
      <div style={{ fontSize: 15, color: '#e2e8f0', fontWeight: 500 }}>
        No favorites yet
      </div>
      <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
        Click the heart on any niche or video card across the other tabs to
        save it here. Niches go on your shortlist for production; videos go
        underneath the niche as proof points.
      </div>
      <div style={{ fontSize: 12, marginTop: 16, color: '#64748b' }}>
        Tip: the Outlier videos tab is the fastest way to find favoriteable
        proof points.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status chips + sort dropdown
// ---------------------------------------------------------------------------

function StatusChips({
  value,
  counts,
  onChange,
}: {
  value: StatusFilter;
  counts: Record<StatusFilter, number>;
  onChange: (next: StatusFilter) => void;
}): React.ReactElement {
  const options: StatusFilter[] = ['all', 'considering', 'committed', 'parked', 'passed'];
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((opt) => {
        const active = value === opt;
        const label = opt === 'all' ? 'All' : STATUS_LABELS[opt];
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              borderRadius: 999,
              border: `1px solid ${active ? '#22c55e' : '#334155'}`,
              background: active ? 'rgba(34,197,94,0.08)' : 'transparent',
              color: active ? '#86efac' : '#94a3b8',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {label} <span style={{ color: '#64748b' }}>{counts[opt]}</span>
          </button>
        );
      })}
    </div>
  );
}

function SortDropdown({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (next: SortKey) => void;
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SortKey)}
      style={{
        padding: '4px 8px',
        background: '#0f172a',
        color: '#e2e8f0',
        border: '1px solid #334155',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <option value="recent">Sort: Most recent</option>
      <option value="name">Sort: Name</option>
    </select>
  );
}

// ---------------------------------------------------------------------------
// One favorite niche panel
// ---------------------------------------------------------------------------

interface FavoritePanelProps {
  favorite: NicheFavoriteWithVideos;
  onChanged: () => Promise<void>;
  /** True when this niche is currently in the Compare selection. */
  compareSelected: boolean;
  /** True when Compare selection is at the cap AND this niche isn't
   *  one of the selected — i.e. clicking would do nothing. */
  compareDisabled: boolean;
  onToggleCompare: () => void;
}

function FavoritePanel({
  favorite,
  onChanged,
  compareSelected,
  compareDisabled,
  onToggleCompare,
}: FavoritePanelProps): React.ReactElement {
  const placeholder = isPlaceholderScores(favorite.scores);

  return (
    <div
      style={{
        border: compareSelected
          ? '1px solid rgba(34,197,94,0.45)'
          : '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        background: compareSelected ? 'rgba(34,197,94,0.03)' : 'rgba(255,255,255,0.02)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <PanelHeader
        favorite={favorite}
        placeholder={placeholder}
        onChanged={onChanged}
        compareSelected={compareSelected}
        compareDisabled={compareDisabled}
        onToggleCompare={onToggleCompare}
      />

      <ScoreRow favorite={favorite} placeholder={placeholder} />

      <NicheBriefCard
        nicheSlug={favorite.niche_slug}
        scoresArePlaceholder={placeholder}
      />

      <VerdictOutcomeRow favorite={favorite} />

      <VideosStrip videos={favorite.videos} />

      <NotesField favorite={favorite} />

      <ActionsRow favorite={favorite} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel header — name, status pill, source tab badge
// ---------------------------------------------------------------------------

function PanelHeader({
  favorite,
  placeholder,
  onChanged,
  compareSelected,
  compareDisabled,
  onToggleCompare,
}: {
  favorite: NicheFavoriteWithVideos;
  placeholder: boolean;
  onChanged: () => Promise<void>;
  compareSelected: boolean;
  compareDisabled: boolean;
  onToggleCompare: () => void;
}): React.ReactElement {
  const onStatusChange = useCallback(
    async (next: FavoriteStatus) => {
      if (!isValidStatus(next)) return;
      const slug = favorite.niche_slug;
      // Optimistic — mutate the cached row's status.
      applyOptimisticFavorite({ ...favorite, status: next, updated_at: new Date().toISOString() });
      const res = await fetch(`/api/niche-finder/favorites/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        invalidateFavoritesIndex();
        await onChanged();
      }
    },
    [favorite, onChanged],
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <label
        title={
          compareDisabled
            ? 'Compare selection is full (max 3). Uncheck another favorite first.'
            : compareSelected
              ? 'Remove from Compare selection'
              : 'Add to Compare selection'
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: compareSelected ? '#86efac' : compareDisabled ? '#475569' : '#94a3b8',
          cursor: compareDisabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        }}
      >
        <input
          type="checkbox"
          checked={compareSelected}
          onChange={onToggleCompare}
          disabled={compareDisabled}
          style={{
            margin: 0,
            cursor: compareDisabled ? 'not-allowed' : 'pointer',
            accentColor: '#22c55e',
          }}
        />
        Compare
      </label>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', flex: 1, minWidth: 0 }}>
        {favorite.niche_name}
      </div>
      {placeholder && (
        <span
          title="Scores haven't been computed for this niche yet. Run a deep-dive to populate them."
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: '#fbbf24',
            background: 'rgba(251,191,36,0.10)',
            border: '1px solid rgba(251,191,36,0.30)',
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          Scores pending
        </span>
      )}
      <select
        value={favorite.status}
        onChange={(e) => void onStatusChange(e.target.value as FavoriteStatus)}
        style={{
          padding: '3px 8px',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: STATUS_COLORS[favorite.status],
          background: 'transparent',
          border: `1px solid ${STATUS_COLORS[favorite.status]}`,
          borderRadius: 999,
          cursor: 'pointer',
        }}
        aria-label="Status"
      >
        {(Object.keys(STATUS_LABELS) as FavoriteStatus[]).map((s) => (
          <option key={s} value={s} style={{ background: '#0d0d14' }}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score row
// ---------------------------------------------------------------------------

function ScoreRow({
  favorite,
  placeholder,
}: {
  favorite: NicheFavoriteWithVideos;
  placeholder: boolean;
}): React.ReactElement {
  const s = favorite.scores;
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '4px 16px',
        fontSize: 12,
        margin: 0,
      }}
    >
      <ScoreItem label="Demand" value={placeholder ? '—' : s.demand.label} />
      <ScoreItem label="Crowdedness" value={placeholder ? '—' : s.supply.label} />
      <ScoreItem
        label="Per 1k views"
        value={
          placeholder
            ? '—'
            : `$${s.monetization.lowUsdPerMille.toFixed(0)}–$${s.monetization.highUsdPerMille.toFixed(0)}`
        }
      />
      <ScoreItem label="Fit" value={placeholder ? '—' : s.fit.label} />
    </dl>
  );
}

function ScoreItem({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </dt>
      <dd style={{ color: '#cbd5e1', margin: 0, fontSize: 13 }}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes — autosaved
// ---------------------------------------------------------------------------

function NotesField({ favorite }: { favorite: NicheFavoriteWithVideos }): React.ReactElement {
  const [value, setValue] = useState(favorite.notes ?? '');
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Debounce: only schedule the PATCH inside the effect; the saving
  // indicator transition runs in onChange so the effect doesn't have
  // to setState itself.
  useEffect(() => {
    if (value === (favorite.notes ?? '')) return;
    const handle = setTimeout(async () => {
      try {
        await fetch(`/api/niche-finder/favorites/${encodeURIComponent(favorite.niche_slug)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: value }),
        });
        setSavingState('saved');
        applyOptimisticFavorite({
          ...favorite,
          notes: value,
          updated_at: new Date().toISOString(),
        });
        setTimeout(() => setSavingState('idle'), 1500);
      } catch {
        setSavingState('idle');
      }
    }, 800);
    return () => clearTimeout(handle);
  }, [favorite, value]);

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value !== (favorite.notes ?? '')) setSavingState('saving');
        }}
        placeholder="Your notes on this niche — what you like, ideas, who could host…"
        rows={2}
        maxLength={4000}
        style={{
          width: '100%',
          padding: '8px 10px',
          background: '#0f172a',
          color: '#e2e8f0',
          border: '1px solid #1e293b',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'inherit',
          resize: 'vertical',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      <div
        style={{
          fontSize: 10,
          color:
            savingState === 'saving' ? '#64748b' : savingState === 'saved' ? '#86efac' : '#475569',
          marginTop: 2,
        }}
      >
        {savingState === 'saving' ? 'Saving…' : savingState === 'saved' ? 'Saved' : ''}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proof videos strip
// ---------------------------------------------------------------------------

function VideosStrip({ videos }: { videos: NicheFavoriteVideoRow[] }): React.ReactElement {
  if (videos.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>
        No proof videos saved under this niche yet. Star a video on the Outliers tab.
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, paddingBottom: 4 }}>
        {videos.map((v) => (
          <VideoChip key={v.id} video={v} />
        ))}
      </div>
    </div>
  );
}

function VideoChip({ video }: { video: NicheFavoriteVideoRow }): React.ReactElement {
  const dim = video.is_removed_upstream;
  return (
    <a
      href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.video_id)}`}
      target="_blank"
      rel="noopener noreferrer"
      title={video.title}
      style={{
        flexShrink: 0,
        width: 150,
        textDecoration: 'none',
        color: 'inherit',
        opacity: dim ? 0.4 : 1,
      }}
    >
      <div style={{ position: 'relative' }}>
        {video.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnail_url}
            alt=""
            width={150}
            height={84}
            style={{ width: 150, height: 84, objectFit: 'cover', borderRadius: 6, display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: 150,
              height: 84,
              borderRadius: 6,
              background: '#1e293b',
            }}
          />
        )}
        {video.classification && (
          <span
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.7)',
              color:
                video.classification === 'viral'
                  ? '#c084fc'
                  : video.classification === 'breakout'
                    ? '#86efac'
                    : video.classification === 'normal'
                      ? '#fbbf24'
                      : '#cbd5e1',
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            {video.classification}
          </span>
        )}
        {dim && (
          <span
            style={{
              position: 'absolute',
              bottom: 4,
              left: 4,
              right: 4,
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 3,
              background: 'rgba(248,113,113,0.85)',
              color: '#0a0e16',
              textAlign: 'center',
              fontWeight: 600,
            }}
          >
            Video unavailable
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 11,
          color: '#cbd5e1',
          marginTop: 4,
          lineHeight: 1.3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {video.title}
      </div>
      <div style={{ fontSize: 10, color: '#64748b' }}>
        {video.channel_title ?? ''}
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Verdict + Outcome row (learning-loop fields)
// ---------------------------------------------------------------------------

function VerdictOutcomeRow({ favorite }: { favorite: NicheFavoriteWithVideos }): React.ReactElement {
  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      // Optimistic refresh.
      applyOptimisticFavorite({ ...favorite, ...body, updated_at: new Date().toISOString() });
      const res = await fetch(`/api/niche-finder/favorites/${encodeURIComponent(favorite.niche_slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) invalidateFavoritesIndex();
    },
    [favorite],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.015)',
        border: '1px solid rgba(255,255,255,0.04)',
        borderRadius: 8,
      }}
    >
      <FieldSelect
        label="Brief verdict"
        value={favorite.verdict ?? ''}
        options={[
          { value: '', label: '— not set —' },
          { value: 'accept', label: VERDICT_LABELS.accept },
          { value: 'override', label: VERDICT_LABELS.override },
          { value: 'reject', label: VERDICT_LABELS.reject },
        ]}
        onChange={(v) => void patch({ verdict: v === '' ? null : v })}
      />
      <FieldSelect
        label="Outcome"
        value={favorite.outcome ?? ''}
        options={[
          { value: '', label: '— not yet —' },
          { value: 'producing', label: OUTCOME_LABELS.producing },
          { value: 'produced', label: OUTCOME_LABELS.produced },
          { value: 'parked', label: OUTCOME_LABELS.parked },
          { value: 'killed', label: OUTCOME_LABELS.killed },
        ]}
        onChange={(v) => void patch({ outcome: v === '' ? null : v })}
      />
      {favorite.outcome === 'produced' && (
        <FieldInput
          label="Produced video URL or ID"
          value={favorite.outcome_video_id ?? ''}
          onCommit={(v) => void patch({ outcomeVideoId: v.trim().length === 0 ? null : v.trim() })}
          placeholder="https://youtube.com/watch?v=…"
        />
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}): React.ReactElement {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
      <span style={{ color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '4px 6px',
          background: '#0f172a',
          color: '#cbd5e1',
          border: '1px solid #334155',
          borderRadius: 6,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: '#0d0d14' }}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FieldInput({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
}): React.ReactElement {
  // Uncontrolled input keyed by the parent value — the input re-mounts
  // when an external write changes `value`, picking up the fresh
  // default without the setState-in-effect anti-pattern. Commit on
  // blur reads the current DOM value directly.
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, flex: '1 1 220px', minWidth: 0 }}>
      <span style={{ color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      <input
        key={value}
        type="text"
        defaultValue={value}
        onBlur={(e) => {
          if (e.currentTarget.value !== value) onCommit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        placeholder={placeholder}
        style={{
          padding: '4px 8px',
          background: '#0f172a',
          color: '#e2e8f0',
          border: '1px solid #334155',
          borderRadius: 6,
          fontSize: 12,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Actions row
// ---------------------------------------------------------------------------

function ActionsRow({
  favorite,
  onChanged,
}: {
  favorite: NicheFavoriteWithVideos;
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [exportingSheet, setExportingSheet] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const onRemove = useCallback(async () => {
    applyOptimisticUnfavorite(favorite.niche_slug);
    const res = await fetch(
      `/api/niche-finder/favorites/${encodeURIComponent(favorite.niche_slug)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      invalidateFavoritesIndex();
      await onChanged();
    }
    setConfirming(false);
    setConfirmText('');
  }, [favorite.niche_slug, onChanged]);

  const onExportSheet = useCallback(async () => {
    if (exportingSheet) return;
    setExportingSheet(true);
    setExportError(null);
    try {
      const res = await fetch(
        `/api/niche-finder/favorites/${encodeURIComponent(favorite.niche_slug)}/export-sheet`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        const code = body?.error ?? '';
        const msg = body?.message ?? body?.error ?? `Export failed (${res.status})`;
        if (code === 'NEEDS_GOOGLE_AUTH' || code === 'NEEDS_REAUTH') {
          setExportError(`${msg} Open Settings → Google Account.`);
        } else {
          setExportError(msg);
        }
        return;
      }
      const body = (await res.json()) as { sheetUrl?: string };
      if (body.sheetUrl) {
        window.open(body.sheetUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setExportingSheet(false);
    }
  }, [exportingSheet, favorite.niche_slug]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
      <button
        type="button"
        onClick={() => exportSingleFavoriteCSV(favorite)}
        style={pillBtn('#334155')}
      >
        Export niche (CSV)
      </button>
      <button
        type="button"
        onClick={() => void onExportSheet()}
        disabled={exportingSheet}
        style={pillBtn('#334155')}
        title="Open this niche + its proof videos + the active brief in a new Google Sheet"
      >
        {exportingSheet ? 'Exporting…' : 'Export niche (Sheets)'}
      </button>
      {exportError && (
        <span
          style={{ fontSize: 11, color: '#fca5a5', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={exportError}
        >
          {exportError}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {confirming ? (
        <>
          <input
            type="text"
            placeholder={`Type "${favorite.niche_name}" to confirm`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
            style={{
              padding: '5px 10px',
              background: '#0f172a',
              color: '#e2e8f0',
              border: '1px solid #f87171',
              borderRadius: 6,
              fontSize: 12,
              minWidth: 220,
            }}
          />
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={confirmText !== favorite.niche_name}
            style={{
              padding: '5px 10px',
              background:
                confirmText === favorite.niche_name ? 'rgba(248,113,113,0.18)' : '#1e293b',
              color: confirmText === favorite.niche_name ? '#f87171' : '#475569',
              border: `1px solid ${
                confirmText === favorite.niche_name ? '#f87171' : '#334155'
              }`,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: confirmText === favorite.niche_name ? 'pointer' : 'not-allowed',
            }}
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setConfirmText('');
            }}
            style={pillBtn('#334155')}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          style={{
            padding: '5px 10px',
            background: 'transparent',
            color: '#94a3b8',
            border: '1px solid #334155',
            borderRadius: 6,
            fontSize: 12,
            cursor: 'pointer',
          }}
          title="Removes from favorites. Restorable for 30 days."
        >
          Remove favorite
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recently-removed (30d restore bin)
// ---------------------------------------------------------------------------

interface RemovedRow extends NicheFavoriteRow {
  deleted_at: string;
}

function RecentlyRemovedSection({ onRestore }: { onRestore: () => Promise<void> }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState<RemovedRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/niche-finder/favorites/recently-removed');
      if (!res.ok) {
        setRemoved([]);
        return;
      }
      const body = (await res.json()) as { favorites: RemovedRow[] };
      setRemoved(body.favorites);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && removed === null) void load();
  }, [open, removed, load]);

  const restore = useCallback(
    async (slug: string) => {
      const res = await fetch(
        `/api/niche-finder/favorites/${encodeURIComponent(slug)}/restore`,
        { method: 'POST' },
      );
      if (res.ok) {
        setRemoved((cur) => (cur ? cur.filter((r) => r.niche_slug !== slug) : cur));
        await onRestore();
      }
    },
    [onRestore],
  );

  return (
    <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.06)' }}>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        style={{
          background: 'transparent',
          color: '#64748b',
          border: 'none',
          fontSize: 12,
          cursor: 'pointer',
          padding: 0,
          textDecoration: 'underline',
        }}
      >
        {open ? 'Hide' : 'Show'} recently removed (30-day restore)
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {loading && <div style={{ fontSize: 12, color: '#64748b' }}>Loading…</div>}
          {removed && removed.length === 0 && (
            <div style={{ fontSize: 12, color: '#64748b' }}>Nothing in the restore bin.</div>
          )}
          {removed && removed.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {removed.map((r) => (
                <li
                  key={r.niche_slug}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 12,
                    color: '#94a3b8',
                    padding: '4px 0',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.niche_name}
                  </span>
                  <span style={{ fontSize: 10, color: '#475569' }}>
                    removed {timeAgo(r.deleted_at)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void restore(r.niche_slug)}
                    style={{
                      padding: '3px 8px',
                      background: 'transparent',
                      color: '#86efac',
                      border: '1px solid rgba(34,197,94,0.4)',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pillBtn(borderColor: string): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: 'transparent',
    color: '#cbd5e1',
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

/** Small caption shown in the top bar's second row: "Spent this month
 *  on briefs: $X.XX". Fetches once on mount + on key changes (favorites
 *  added/removed signals a likely brief generation). Silent on
 *  failure — this is a "nice to know" widget, not a critical surface. */
function MonthlyBriefSpendCaption({ refreshKey }: { refreshKey: number }): React.ReactElement | null {
  const [usd, setUsd] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/niche-finder/favorites/brief-stats');
        if (!res.ok) return;
        const body = (await res.json()) as { monthlySpendUsd?: number };
        if (!cancelled) setUsd(typeof body.monthlySpendUsd === 'number' ? body.monthlySpendUsd : null);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (usd === null) return null;
  return (
    <span style={{ fontSize: 11, color: '#64748b' }} title="Sum of all 'ready' brief costs in the current month">
      Spent this month on briefs: <span style={{ color: '#94a3b8', fontWeight: 500 }}>${usd.toFixed(2)}</span>
    </span>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
