'use client';

/**
 * Picker modal shown when the operator favorites a video from a tab
 * where the niche context is ambiguous (e.g. the Channel cluster
 * view). Lists existing favorite niches; lets the operator pick one
 * to attach the video to, OR create a brand-new favorite niche from
 * just the video's title.
 *
 * "New favorite niche from this video" creates the niche with
 * placeholder zero-scores — the operator can later run a deep-dive
 * to populate real scores. This trade-off keeps the modal flow
 * one-decision instead of three (name → run deep-dive → attach).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  PLACEHOLDER_NICHE_SCORES,
  type FavoriteSourceTab,
  type NicheFavoriteWithVideos,
} from '@/lib/niche-finder/favorites';
import type { NicheScores } from '@/lib/niche-finder/types';
import { slugifyNiche, normalizeNicheName } from '@/lib/niche-finder/slug';

interface FavoriteAssignmentModalProps {
  video: {
    videoId: string;
    title: string;
    thumbnailUrl?: string | null;
    channelTitle?: string;
  };
  existingFavorites: NicheFavoriteWithVideos[];
  sourceTab: FavoriteSourceTab;
  onClose: () => void;
  onAttach: (ctx: {
    slug: string;
    name: string;
    scores: NicheScores;
    sourceTab: FavoriteSourceTab;
  }) => Promise<void>;
}

export function FavoriteAssignmentModal({
  video,
  existingFavorites,
  sourceTab,
  onClose,
  onAttach,
}: FavoriteAssignmentModalProps): React.ReactElement {
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  // Esc to close + lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [busy, onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return existingFavorites;
    return existingFavorites.filter((f) =>
      `${f.niche_name} ${f.niche_slug}`.toLowerCase().includes(q),
    );
  }, [existingFavorites, search]);

  async function attachToExisting(f: NicheFavoriteWithVideos): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await onAttach({
        slug: f.niche_slug,
        name: f.niche_name,
        scores: f.scores,
        sourceTab,
      });
    } finally {
      setBusy(false);
    }
  }

  async function createAndAttach(): Promise<void> {
    if (busy) return;
    const name = normalizeNicheName(newName);
    if (!name || name === 'Untitled niche') return;
    setBusy(true);
    try {
      await onAttach({
        slug: slugifyNiche(name),
        name,
        scores: PLACEHOLDER_NICHE_SCORES,
        sourceTab,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Save video under a niche"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
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
          maxWidth: 520,
          width: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header — the video being saved */}
        <div
          style={{
            padding: 14,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          {video.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnailUrl}
              alt=""
              width={90}
              height={50}
              style={{ width: 90, height: 50, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Save this video under a niche
            </div>
            <div
              style={{
                fontSize: 14,
                color: '#e2e8f0',
                fontWeight: 500,
                marginTop: 4,
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
            {video.channelTitle && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{video.channelTitle}</div>
            )}
          </div>
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
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Search / existing favorites list */}
        <div style={{ padding: 14, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <input
            type="text"
            autoFocus
            placeholder={
              existingFavorites.length === 0
                ? 'No favorite niches yet — create one below'
                : `Search ${existingFavorites.length} favorite niche${existingFavorites.length === 1 ? '' : 's'}…`
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={existingFavorites.length === 0}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: '#0f172a',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: 8,
              fontSize: 13,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {filtered.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: '4px 8px' }}>
              {filtered.map((f) => (
                <li key={f.niche_slug}>
                  <button
                    type="button"
                    onClick={() => void attachToExisting(f)}
                    disabled={busy}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 12px',
                      background: 'transparent',
                      color: '#e2e8f0',
                      border: '1px solid transparent',
                      borderRadius: 8,
                      cursor: busy ? 'wait' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                    }}
                    onMouseEnter={(e) => {
                      if (!busy) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.niche_name}
                    </span>
                    <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>
                      {f.videos.length} video{f.videos.length === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : existingFavorites.length > 0 ? (
            <div style={{ padding: '14px 16px', color: '#64748b', fontSize: 13 }}>
              No matches. Try a different search, or create a new favorite niche below.
            </div>
          ) : null}
        </div>

        {/* Create new niche */}
        <div
          style={{
            padding: 14,
            borderTop: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Or save as a new favorite niche
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="Niche name (e.g. 'AI productivity for solopreneurs')"
              value={newName}
              onChange={(e) => setNewName(e.target.value.slice(0, 120))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && newName.trim().length > 0) void createAndAttach();
              }}
              style={{
                flex: 1,
                padding: '8px 12px',
                background: '#0f172a',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: 8,
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => void createAndAttach()}
              disabled={busy || newName.trim().length === 0}
              style={{
                padding: '8px 14px',
                background: newName.trim().length > 0 ? '#22c55e' : '#1e293b',
                color: newName.trim().length > 0 ? '#0a0e16' : '#64748b',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: busy ? 'wait' : newName.trim().length > 0 ? 'pointer' : 'not-allowed',
                flexShrink: 0,
              }}
            >
              {busy ? 'Saving…' : 'Create & save'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 1.4 }}>
            Scores will populate after the first deep-dive on this niche.
          </div>
        </div>
      </div>
    </div>
  );
}
