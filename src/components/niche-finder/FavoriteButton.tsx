'use client';

/**
 * Heart-icon button placed on every result card in the niche finder.
 * Two render modes:
 *
 *   kind="niche"  — favorites the niche directly. Used by
 *                   DiscoveryCard and the taxonomy drill-down rows.
 *
 *   kind="video"  — favorites a video under a niche. Uses the
 *                   `activeNicheContext` prop to auto-attach when the
 *                   context is unambiguous (operator is on the
 *                   Outliers tab for a specific niche). When that prop
 *                   is null, opens the FavoriteAssignmentModal so the
 *                   operator picks a niche.
 *
 * The heart is intentionally NOT a star — stars on YouTube read as
 * "rate this" and would be confusing in this collection context.
 *
 * Backed by the shared FavoritesIndex hook so 50 cards mounted at the
 * same time share a single network round-trip.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NicheScores } from '@/lib/niche-finder/types';
import type {
  FavoriteSourceTab,
  NicheFavoriteRow,
  NicheFavoriteVideoRow,
} from '@/lib/niche-finder/favorites';
import {
  applyOptimisticAddVideo,
  applyOptimisticFavorite,
  applyOptimisticRemoveVideo,
  applyOptimisticUnfavorite,
  invalidateFavoritesIndex,
  useFavoritesIndex,
} from '@/lib/niche-finder/favorites-client';
import { slugifyNiche } from '@/lib/niche-finder/slug';
import { FavoriteAssignmentModal } from './FavoriteAssignmentModal';

interface NicheButtonProps {
  kind: 'niche';
  slug: string;
  name: string;
  scores: NicheScores;
  sourceTab: FavoriteSourceTab;
  /** Optional visual variant. 'inline' is the default — a small heart
   *  next to the title; 'overlay' is a circular floating button used
   *  on top of thumbnails. */
  variant?: 'inline' | 'overlay';
}

interface VideoButtonProps {
  kind: 'video';
  video: {
    videoId: string;
    channelId: string;
    title: string;
    thumbnailUrl?: string | null;
    viewCount?: number;
    publishedAt?: string;
    outlierScore?: number;
    classification?: 'underperformer' | 'normal' | 'breakout' | 'viral';
    durationIso?: string;
    channelTitle?: string;
    subscriberCount?: number;
  };
  /** When set, video favorites auto-attach to this niche silently.
   *  When null, clicking opens the assignment modal. */
  activeNicheContext: {
    slug: string;
    name: string;
    scores: NicheScores;
    sourceTab: FavoriteSourceTab;
  } | null;
  sourceTab: FavoriteSourceTab;
  variant?: 'inline' | 'overlay';
}

export type FavoriteButtonProps = NicheButtonProps | VideoButtonProps;

export function FavoriteButton(props: FavoriteButtonProps): React.ReactElement {
  if (props.kind === 'niche') return <NicheFavoriteHeart {...props} />;
  return <VideoFavoriteHeart {...props} />;
}

// ---------------------------------------------------------------------------
// Niche heart — saves / unsaves a niche directly.
// ---------------------------------------------------------------------------

function NicheFavoriteHeart({ slug, name, scores, sourceTab, variant = 'inline' }: NicheButtonProps): React.ReactElement {
  const canonical = slugifyNiche(slug);
  const { index, loading } = useFavoritesIndex();
  const [busy, setBusy] = useState(false);
  const isFavorited = index.bySlug.has(canonical);

  const onToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      try {
        if (isFavorited) {
          applyOptimisticUnfavorite(canonical);
          const res = await fetch(`/api/niche-finder/favorites/${encodeURIComponent(canonical)}`, {
            method: 'DELETE',
          });
          if (!res.ok) invalidateFavoritesIndex(); // resync on error
        } else {
          // Optimistic favorite with a placeholder row; the real row
          // (with server-side timestamps) lands when the POST returns.
          const placeholder: NicheFavoriteRow = {
            workspace_id: '',
            niche_slug: canonical,
            niche_name: name,
            source_tab: sourceTab,
            scores,
            notes: null,
            status: 'considering',
            verdict: null,
            verdict_reason: null,
            outcome: null,
            outcome_video_id: null,
            outcome_reason: null,
            created_by_user_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          };
          applyOptimisticFavorite(placeholder);
          const res = await fetch('/api/niche-finder/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nicheSlug: canonical,
              nicheName: name,
              sourceTab,
              scores,
            }),
          });
          if (res.ok) {
            const body = (await res.json()) as { favorite: NicheFavoriteRow };
            applyOptimisticFavorite(body.favorite);
          } else {
            invalidateFavoritesIndex();
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, canonical, isFavorited, name, scores, sourceTab],
  );

  return (
    <HeartChip
      filled={isFavorited}
      busy={busy || loading}
      onClick={onToggle}
      variant={variant}
      title={isFavorited ? 'Remove from favorites' : 'Save to favorites'}
      aria-label={isFavorited ? 'Remove from favorites' : 'Save to favorites'}
    />
  );
}

// ---------------------------------------------------------------------------
// Video heart — favorites the video under a niche (hybrid assignment).
// ---------------------------------------------------------------------------

function VideoFavoriteHeart({ video, activeNicheContext, sourceTab, variant = 'overlay' }: VideoButtonProps): React.ReactElement {
  const { index, loading } = useFavoritesIndex();
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // A video is "favorited" if it appears under ANY niche. We show the
  // filled heart in that case; the modal flow lets the operator
  // attach to additional niches if desired.
  const attachments = useMemo(
    () => index.videoMap.get(video.videoId) ?? [],
    [index, video.videoId],
  );
  const isFavorited = attachments.length > 0;

  const attachToNiche = useCallback(
    async (ctx: { slug: string; name: string; scores: NicheScores; sourceTab: FavoriteSourceTab }) => {
      const canonical = slugifyNiche(ctx.slug);
      // First ensure the favorite niche exists.
      const niche = index.bySlug.get(canonical);
      if (!niche) {
        const placeholder: NicheFavoriteRow = {
          workspace_id: '',
          niche_slug: canonical,
          niche_name: ctx.name,
          source_tab: ctx.sourceTab,
          scores: ctx.scores,
          notes: null,
          status: 'considering',
          verdict: null,
          verdict_reason: null,
          outcome: null,
          outcome_video_id: null,
          outcome_reason: null,
          created_by_user_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        };
        applyOptimisticFavorite(placeholder);
        const createRes = await fetch('/api/niche-finder/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nicheSlug: canonical,
            nicheName: ctx.name,
            sourceTab: ctx.sourceTab,
            scores: ctx.scores,
          }),
        });
        if (createRes.ok) {
          const body = (await createRes.json()) as { favorite: NicheFavoriteRow };
          applyOptimisticFavorite(body.favorite);
        } else {
          invalidateFavoritesIndex();
          return;
        }
      }

      // Then add the video.
      const placeholderVideo: NicheFavoriteVideoRow = {
        id: `optimistic-${video.videoId}`,
        workspace_id: '',
        niche_slug: canonical,
        video_id: video.videoId,
        channel_id: video.channelId,
        title: video.title,
        thumbnail_url: video.thumbnailUrl ?? null,
        view_count: video.viewCount ?? null,
        published_at: video.publishedAt ?? null,
        outlier_score: video.outlierScore ?? null,
        classification: video.classification ?? null,
        duration_iso: video.durationIso ?? null,
        channel_title: video.channelTitle ?? null,
        subscriber_count: video.subscriberCount ?? null,
        is_removed_upstream: false,
        last_validated_at: null,
        added_at: new Date().toISOString(),
        added_by_user_id: null,
      };
      applyOptimisticAddVideo(canonical, placeholderVideo);
      const res = await fetch(
        `/api/niche-finder/favorites/${encodeURIComponent(canonical)}/videos`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as { video: NicheFavoriteVideoRow };
        applyOptimisticAddVideo(canonical, body.video);
      } else {
        invalidateFavoritesIndex();
      }
    },
    [index.bySlug, video],
  );

  const onToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      try {
        if (isFavorited) {
          // Remove from every niche it's attached to. Most common case
          // is one attachment; the loop handles multi-niche cleanly.
          for (const a of attachments) {
            applyOptimisticRemoveVideo(a.niche_slug, video.videoId);
            const res = await fetch(
              `/api/niche-finder/favorites/${encodeURIComponent(a.niche_slug)}/videos/${encodeURIComponent(video.videoId)}`,
              { method: 'DELETE' },
            );
            if (!res.ok) invalidateFavoritesIndex();
          }
          return;
        }
        if (activeNicheContext) {
          await attachToNiche(activeNicheContext);
        } else {
          // Ambiguous context → open the picker modal.
          setModalOpen(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [activeNicheContext, attachments, attachToNiche, busy, isFavorited, video.videoId],
  );

  return (
    <>
      <HeartChip
        filled={isFavorited}
        busy={busy || loading}
        onClick={onToggle}
        variant={variant}
        title={
          isFavorited
            ? attachments.length === 1
              ? `Saved under ${attachments[0].niche_name}`
              : `Saved under ${attachments.length} niches`
            : 'Save to favorites'
        }
        aria-label={isFavorited ? 'Remove from favorites' : 'Save to favorites'}
      />
      {modalOpen && (
        <FavoriteAssignmentModal
          video={video}
          existingFavorites={index.favorites}
          sourceTab={sourceTab}
          onClose={() => setModalOpen(false)}
          onAttach={async (ctx) => {
            await attachToNiche(ctx);
            setModalOpen(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Heart chip — visual primitive shared by both modes.
// ---------------------------------------------------------------------------

interface HeartChipProps {
  filled: boolean;
  busy: boolean;
  onClick: (e: React.MouseEvent) => void;
  variant: 'inline' | 'overlay';
  title: string;
  'aria-label': string;
}

function HeartChip({ filled, busy, onClick, variant, title, ...rest }: HeartChipProps): React.ReactElement {
  const isOverlay = variant === 'overlay';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={rest['aria-label']}
      aria-pressed={filled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: isOverlay ? 28 : 24,
        height: isOverlay ? 28 : 24,
        padding: 0,
        background: isOverlay
          ? filled
            ? 'rgba(239, 68, 68, 0.18)'
            : 'rgba(0, 0, 0, 0.55)'
          : 'transparent',
        color: filled ? '#f87171' : '#94a3b8',
        border: isOverlay
          ? `1px solid ${filled ? 'rgba(239, 68, 68, 0.55)' : 'rgba(255,255,255,0.12)'}`
          : '1px solid transparent',
        borderRadius: 999,
        cursor: busy ? 'wait' : 'pointer',
        transition: 'color 0.15s, background 0.15s, transform 0.1s',
        flexShrink: 0,
      }}
      onMouseDown={(e) => {
        if (!busy) e.currentTarget.style.transform = 'scale(0.92)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = '';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = '';
      }}
    >
      <HeartIcon filled={filled} size={isOverlay ? 16 : 14} />
    </button>
  );
}

function HeartIcon({ filled, size }: { filled: boolean; size: number }): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
