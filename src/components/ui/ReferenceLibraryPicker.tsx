'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

interface LibraryItem {
  id: string;
  youtube_id: string;
  url: string;
  title: string;
  channel_title: string;
  view_count: number;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  has_analysis: boolean;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  notes: string | null;
  user_tags: string[];
}

export interface PickedReference {
  url: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  thumbnailUrl: string | null;
  styleAnalysis: string | null;
  /** The full structured analysis JSON, when available. */
  analysis: Record<string, unknown> | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** YouTube IDs already added to the current generation — so we can grey
   *  them out in the list and prevent dupes. */
  excludeYoutubeIds?: string[];
  /** Called once per click. Caller decides what to do (typically: append
   *  to the references array on the generator page). */
  onPick: (ref: PickedReference) => void;
}

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString();
}

function formatDuration(s: number | null): string {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Browse-and-pick UI for the user's saved reference library. Backed by
 * /api/reference-library — every YouTube video that's been deep-analyzed
 * is cached server-side, and this picker lets the user re-attach prior
 * analyses to a new generation without re-scraping.
 */
export function ReferenceLibraryPicker({ open, onClose, excludeYoutubeIds = [], onPick }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set('q', search.trim());
        params.set('limit', '100');
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/reference-library?${params}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setItems(data.items || []);
        }
      } catch {} finally { if (!cancelled) setLoading(false); }
    }, 200); // debounce search input
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, search]);

  const excluded = useMemo(() => new Set(excludeYoutubeIds), [excludeYoutubeIds]);

  async function pick(item: LibraryItem) {
    if (excluded.has(item.youtube_id)) return;
    setPicking(item.id);
    try {
      // Fetch the full record so we have the analysis JSON.
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/reference-library/${item.id}`);
      if (!res.ok) throw new Error('Failed to load reference');
      const { reference } = await res.json();
      onPick({
        url: reference.url,
        title: reference.title,
        channelTitle: reference.channel_title,
        viewCount: reference.view_count,
        thumbnailUrl: reference.thumbnail_url,
        styleAnalysis: reference.style_analysis,
        analysis: reference.analysis,
      });
      toast.success(`Added ${reference.title.slice(0, 50)}…`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add');
    } finally {
      setPicking(null);
    }
  }

  async function remove(item: LibraryItem) {
    if (!confirm(`Remove "${item.title}" from your library? This deletes the cached analysis.`)) return;
    setDeleting(item.id);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/reference-library/${item.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      setItems(prev => prev.filter(i => i.id !== item.id));
      toast.success('Removed from library');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(null);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-16"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                📚 Reference Library
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Every YouTube video you&apos;ve deep-analyzed is saved here. Pick one to reuse the analysis instantly — no re-scraping.
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-xl leading-none px-2"
              style={{ color: 'var(--text-muted)' }}
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by title, channel, or notes…"
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {loading && items.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
              <p className="text-sm mb-1">{search ? 'No matches' : 'Your library is empty'}</p>
              <p className="text-xs">{search ? 'Try a different search.' : 'Add a YouTube reference video to get started — analyses are saved here automatically.'}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {items.map(item => {
                const dim = excluded.has(item.youtube_id);
                return (
                  <div
                    key={item.id}
                    className="group flex items-start gap-3 p-2.5 rounded-lg transition-colors"
                    style={{
                      background: 'var(--bg-primary)',
                      border: '1px solid transparent',
                      opacity: dim ? 0.4 : 1,
                      cursor: dim ? 'not-allowed' : 'default',
                    }}
                    onMouseEnter={e => { if (!dim) e.currentTarget.style.borderColor = 'rgba(124,58,237,0.3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                  >
                    {item.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnail_url}
                        alt=""
                        className="w-32 aspect-video object-cover rounded shrink-0"
                      />
                    ) : (
                      <div className="w-32 aspect-video rounded shrink-0" style={{ background: 'var(--bg-secondary)' }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                        {item.title}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                        <span>{item.channel_title}</span>
                        <span>·</span>
                        <span>{formatViews(item.view_count)} views</span>
                        {item.duration_seconds && (
                          <>
                            <span>·</span>
                            <span>{formatDuration(item.duration_seconds)}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {item.has_analysis ? (
                          <span style={{ color: '#22c55e' }}>✓ analyzed</span>
                        ) : (
                          <span style={{ color: '#eab308' }}>⚠ no analysis</span>
                        )}
                        <span>·</span>
                        <span>used {item.use_count}× · {timeAgo(item.last_used_at) === 'never' ? 'never used' : `last ${timeAgo(item.last_used_at)}`}</span>
                      </div>
                      {item.notes && (
                        <p className="text-[11px] mt-1 italic line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                          {item.notes}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => pick(item)}
                        disabled={dim || picking === item.id}
                        className="px-2.5 py-1 rounded text-[11px] font-medium text-white transition-opacity disabled:opacity-50 cursor-pointer"
                        style={{ background: dim ? 'var(--bg-secondary)' : 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                        title={dim ? 'Already added to this generation' : 'Add as reference'}
                      >
                        {picking === item.id ? '…' : dim ? 'Added' : '+ Add'}
                      </button>
                      <button
                        onClick={() => remove(item)}
                        disabled={deleting === item.id}
                        className="px-2.5 py-1 rounded text-[10px] transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                        style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
                        title="Remove from library"
                      >
                        {deleting === item.id ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 shrink-0 text-[11px]" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          {items.length > 0 && `${items.length} saved reference${items.length === 1 ? '' : 's'}`}
        </div>
      </div>
    </div>
  );
}
