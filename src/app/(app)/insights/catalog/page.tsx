'use client';

/**
 * Phase 9.7 — catalog explorer.
 *
 * Power-user table over every video the workspace has published.
 * Sortable columns, filter sidebar, saved views, paginated. URL is
 * deliberately NOT a top-level nav entry — discoverable via the
 * weekly digest's "see all videos" link and via the dashboard's
 * Underperformers section ("Browse all videos →"). If usage is
 * heavy, we promote to a top-level nav slot in a follow-up phase.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  SORT_FIELDS,
  type CatalogFilter,
  type CatalogSort,
  type CatalogVideoRow,
  type SavedView,
  type SortField,
} from '@/lib/catalog-explorer-types';
import { VIDEO_FORMATS, type VideoFormat } from '@/lib/format-tags-types';

interface VideosResponse {
  rows: CatalogVideoRow[];
  total: number;
}

interface ChannelLite {
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

const SORT_LABEL: Record<SortField, string> = {
  published_at: 'Published',
  views: 'Views',
  ctr_percentage: 'CTR',
  average_view_percentage: 'AVP',
  subscribers_gained: 'Subs gained',
  duration_seconds: 'Duration',
  days_since_publish: 'Days live',
};

const FORMAT_LABEL: Record<VideoFormat, string> = {
  explainer: 'Explainer',
  list: 'List',
  story: 'Story',
  tutorial: 'Tutorial',
  commentary: 'Commentary',
  interview: 'Interview',
  vlog: 'Vlog',
  showcase: 'Showcase',
  other: 'Other',
};

export default function CatalogPage() {
  const [filter, setFilter] = useState<CatalogFilter>({ ...DEFAULT_FILTER });
  const [sort, setSort] = useState<CatalogSort>({ ...DEFAULT_SORT });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<VideosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [channels, setChannels] = useState<ChannelLite[]>([]);
  const [saveDraft, setSaveDraft] = useState('');

  // Load channels + saved views once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [chRes, svRes] = await Promise.all([
          fetch('/api/channels', { cache: 'no-store' }),
          fetch('/api/catalog/saved-views', { cache: 'no-store' }),
        ]);
        if (!cancelled && chRes.ok) {
          const j = (await chRes.json()) as { channels?: ChannelLite[] };
          setChannels(j.channels ?? []);
        }
        if (!cancelled && svRes.ok) {
          const j = (await svRes.json()) as { views?: SavedView[] };
          setSavedViews(j.views ?? []);
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the catalog whenever filter / sort / page changes.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/catalog/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter,
          sort,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      });
      if (!res.ok) {
        setData({ rows: [], total: 0 });
        return;
      }
      setData((await res.json()) as VideosResponse);
    } finally {
      setLoading(false);
    }
  }, [filter, sort, page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleArrayFilter<K extends 'channelDbIds' | 'formats' | 'durations'>(
    key: K,
    value: CatalogFilter[K][number],
  ) {
    setPage(0);
    setFilter((f) => {
      const arr = f[key] as string[];
      const has = arr.includes(value as string);
      return {
        ...f,
        [key]: has ? arr.filter((v) => v !== value) : [...arr, value as string],
      } as CatalogFilter;
    });
  }

  function setRangeFilter(
    key: 'avpMin' | 'avpMax' | 'ctrMin' | 'ctrMax',
    raw: string,
  ) {
    setPage(0);
    const n = raw.trim() === '' ? null : Number(raw);
    setFilter((f) => ({ ...f, [key]: Number.isFinite(n as number) ? (n as number) : null }));
  }

  function clickSort(field: SortField) {
    setPage(0);
    setSort((s) =>
      s.field === field
        ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'desc' },
    );
  }

  function applySavedView(v: SavedView) {
    setPage(0);
    setFilter(v.filters);
    setSort(v.sort);
  }

  async function deleteSaved(id: string) {
    const res = await fetch(`/api/catalog/saved-views/${id}`, { method: 'DELETE' });
    if (res.ok) setSavedViews((vs) => vs.filter((v) => v.id !== id));
  }

  async function saveCurrent() {
    if (!saveDraft.trim()) return;
    const res = await fetch('/api/catalog/saved-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: saveDraft.trim(), filter, sort }),
    });
    if (!res.ok) return;
    const j = (await res.json()) as { view?: SavedView };
    if (j.view) setSavedViews((vs) => [j.view!, ...vs]);
    setSaveDraft('');
  }

  const hasActiveFilters = useMemo(() => {
    return (
      filter.channelDbIds.length > 0 ||
      filter.formats.length > 0 ||
      filter.durations.length > 0 ||
      filter.publishedSince !== null ||
      filter.publishedUntil !== null ||
      filter.avpMin !== null ||
      filter.avpMax !== null ||
      filter.ctrMin !== null ||
      filter.ctrMax !== null ||
      filter.onlyBreakouts
    );
  }, [filter]);

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <Link
          href="/dashboard"
          style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none' }}
        >
          ← Dashboard
        </Link>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="gradient-text" style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
            Catalog
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Every video this workspace has published. Slice it however you need.
          </p>
        </div>
        {data && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {data.total.toLocaleString()} video{data.total === 1 ? '' : 's'}{' '}
            {hasActiveFilters && '(filtered)'}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        {/* Filter sidebar */}
        <aside
          className="glass rounded-xl p-3"
          style={{ alignSelf: 'flex-start', position: 'sticky', top: 16 }}
        >
          <FilterGroup label="Channel">
            {channels.map((c) => (
              <Checkbox
                key={c.id}
                label={c.name}
                checked={filter.channelDbIds.includes(c.id)}
                onChange={() => toggleArrayFilter('channelDbIds', c.id)}
              />
            ))}
            {channels.length === 0 && <Hint>No channels yet.</Hint>}
          </FilterGroup>

          <FilterGroup label="Format">
            {VIDEO_FORMATS.map((f) => (
              <Checkbox
                key={f}
                label={FORMAT_LABEL[f]}
                checked={filter.formats.includes(f)}
                onChange={() => toggleArrayFilter('formats', f)}
              />
            ))}
          </FilterGroup>

          <FilterGroup label="Duration">
            {(['shorts', 'short', 'mid', 'long'] as const).map((d) => (
              <Checkbox
                key={d}
                label={
                  d === 'shorts'
                    ? 'Shorts (≤60s)'
                    : d === 'short'
                      ? 'Short (1-5min)'
                      : d === 'mid'
                        ? 'Mid (5-15min)'
                        : 'Long (15min+)'
                }
                checked={filter.durations.includes(d)}
                onChange={() => toggleArrayFilter('durations', d)}
              />
            ))}
          </FilterGroup>

          <FilterGroup label="Published">
            <DateInput
              value={filter.publishedSince}
              onChange={(v) => {
                setPage(0);
                setFilter((f) => ({ ...f, publishedSince: v }));
              }}
              label="From"
            />
            <DateInput
              value={filter.publishedUntil}
              onChange={(v) => {
                setPage(0);
                setFilter((f) => ({ ...f, publishedUntil: v }));
              }}
              label="To"
            />
          </FilterGroup>

          <FilterGroup label="AVP %">
            <RangeRow
              minValue={filter.avpMin}
              maxValue={filter.avpMax}
              onMin={(v) => setRangeFilter('avpMin', v)}
              onMax={(v) => setRangeFilter('avpMax', v)}
            />
          </FilterGroup>

          <FilterGroup label="CTR %">
            <RangeRow
              minValue={filter.ctrMin}
              maxValue={filter.ctrMax}
              onMin={(v) => setRangeFilter('ctrMin', v)}
              onMax={(v) => setRangeFilter('ctrMax', v)}
            />
          </FilterGroup>

          <FilterGroup label="Other">
            <Checkbox
              label="Only breakouts"
              checked={filter.onlyBreakouts}
              onChange={() => {
                setPage(0);
                setFilter((f) => ({ ...f, onlyBreakouts: !f.onlyBreakouts }));
              }}
            />
          </FilterGroup>

          {hasActiveFilters && (
            <button
              onClick={() => {
                setPage(0);
                setFilter({ ...DEFAULT_FILTER });
              }}
              className="btn-secondary"
              style={{ fontSize: 11, marginTop: 8, width: '100%' }}
            >
              Clear filters
            </button>
          )}

          <FilterGroup label="Saved views">
            {savedViews.length === 0 && <Hint>No saved views yet.</Hint>}
            {savedViews.map((v) => (
              <div
                key={v.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                }}
              >
                <button
                  onClick={() => applySavedView(v)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    padding: '4px 6px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 11,
                  }}
                  className="hover:bg-white/[0.04]"
                  title={`Saved by ${v.created_by_user_id ?? 'someone'}`}
                >
                  {v.name}
                </button>
                <button
                  onClick={() => deleteSaved(v.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '0 4px',
                  }}
                  aria-label="Delete saved view"
                >
                  ×
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              <input
                type="text"
                placeholder="Save current filters as…"
                value={saveDraft}
                onChange={(e) => setSaveDraft(e.target.value)}
                style={{
                  flex: 1,
                  padding: '4px 6px',
                  fontSize: 11,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={saveCurrent}
                disabled={!saveDraft.trim()}
                className="btn-secondary"
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                Save
              </button>
            </div>
          </FilterGroup>
        </aside>

        {/* Table */}
        <main className="glass rounded-xl" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <Th>Video</Th>
                  <Th>Channel</Th>
                  <Th>Format</Th>
                  {SORT_FIELDS.map((f) => (
                    <ThSort
                      key={f}
                      label={SORT_LABEL[f]}
                      active={sort.field === f}
                      dir={sort.dir}
                      onClick={() => clickSort(f)}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && data === null && (
                  <tr>
                    <td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                      Loading…
                    </td>
                  </tr>
                )}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No videos match these filters.
                    </td>
                  </tr>
                )}
                {data &&
                  data.rows.map((r) => (
                    <tr
                      key={r.youtube_video_id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    >
                      <td style={{ padding: '8px 10px', maxWidth: 320 }}>
                        <a
                          href={`https://youtu.be/${r.youtube_video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: 'var(--text-primary)',
                            textDecoration: 'none',
                            display: 'block',
                            fontWeight: 500,
                          }}
                        >
                          {r.title || r.youtube_video_id}
                        </a>
                        {r.has_breakout && (
                          <span
                            style={{
                              fontSize: 9,
                              color: '#4ade80',
                              padding: '1px 5px',
                              borderRadius: 999,
                              background: 'rgba(74,222,128,0.1)',
                              border: '1px solid rgba(74,222,128,0.4)',
                              marginRight: 4,
                            }}
                          >
                            🚀 breakout
                          </span>
                        )}
                      </td>
                      <Td>{r.channel_name ?? '—'}</Td>
                      <Td>{r.format ? FORMAT_LABEL[r.format] : '—'}</Td>
                      <Td>{formatDate(r.published_at)}</Td>
                      <Td num>{formatBig(r.views)}</Td>
                      <Td num>{r.ctr_percentage !== null ? `${r.ctr_percentage.toFixed(1)}%` : '—'}</Td>
                      <Td num>
                        {r.average_view_percentage !== null
                          ? `${r.average_view_percentage.toFixed(1)}%`
                          : '—'}
                      </Td>
                      <Td num>{formatBig(r.subscribers_gained)}</Td>
                      <Td>{formatDuration(r.duration_seconds)}</Td>
                      <Td num>
                        {r.days_since_publish !== null
                          ? `${Math.round(r.days_since_publish)}d`
                          : '—'}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {data && pageCount > 1 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                fontSize: 11,
                color: 'var(--text-muted)',
              }}
            >
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="btn-secondary"
                  style={{ fontSize: 11 }}
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1 || loading}
                  className="btn-secondary"
                  style={{ fontSize: 11 }}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---- Small subcomponents ---------------------------------------------------

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--text-muted)',
          marginBottom: 4,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        padding: '2px 0',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0 }}>{children}</p>;
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
      <span style={{ flex: '0 0 32px' }}>{label}</span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        style={{
          flex: 1,
          padding: '2px 4px',
          fontSize: 11,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4,
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
        }}
      />
    </label>
  );
}

function RangeRow({
  minValue,
  maxValue,
  onMin,
  onMax,
}: {
  minValue: number | null;
  maxValue: number | null;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  const inputStyle = {
    width: 56,
    padding: '2px 4px',
    fontSize: 11,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
  } as const;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>
      <input
        type="number"
        placeholder="min"
        value={minValue ?? ''}
        onChange={(e) => onMin(e.target.value)}
        style={inputStyle}
      />
      <span>–</span>
      <input
        type="number"
        placeholder="max"
        value={maxValue ?? ''}
        onChange={(e) => onMax(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '8px 10px',
        fontSize: 10,
        fontWeight: 500,
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        letterSpacing: 0.5,
      }}
    >
      {children}
    </th>
  );
}

function ThSort({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <th
      style={{
        textAlign: 'right',
        padding: '8px 10px',
        fontSize: 10,
        fontWeight: 500,
        textTransform: 'uppercase',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        letterSpacing: 0.5,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={onClick}
      title={active ? `${label} (${dir})` : `Sort by ${label}`}
    >
      {label}
      {active && (dir === 'asc' ? ' ↑' : ' ↓')}
    </th>
  );
}

function Td({ children, num }: { children: React.ReactNode; num?: boolean }) {
  return (
    <td
      style={{
        padding: '8px 10px',
        color: 'var(--text-secondary)',
        textAlign: num ? 'right' : 'left',
        fontVariantNumeric: num ? 'tabular-nums' : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  );
}

function formatBig(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return '—';
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (mins < 60) return remSec === 0 ? `${mins}m` : `${mins}m ${remSec}s`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m`;
}
