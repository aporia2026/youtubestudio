'use client';

/**
 * Client-side favorites index — single fetch shared across every
 * FavoriteButton on the page so 50 cards don't make 50 round trips.
 *
 * Backed by a module-level cache + a tiny pub/sub. The cache is
 * invalidated on every mutation (favorite, unfavorite, add video,
 * remove video) so optimistic UI sticks.
 *
 * Not a React Context — niche-finder pages don't have a provider
 * tree to hook into. Module state is fine because the favorites
 * surface is single-workspace per session.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  NicheFavoriteRow,
  NicheFavoriteVideoRow,
  NicheFavoriteWithVideos,
} from '@/lib/niche-finder/favorites';

export interface FavoritesIndex {
  /** Full hydrated list. */
  favorites: NicheFavoriteWithVideos[];
  /** Fast lookup: niche_slug → favorite row. */
  bySlug: Map<string, NicheFavoriteWithVideos>;
  /** Fast lookup: video_id → array of (slug, niche_name) pairs the
   *  video is favorited under. A video can be under multiple niches. */
  videoMap: Map<string, Array<{ niche_slug: string; niche_name: string }>>;
}

const EMPTY: FavoritesIndex = {
  favorites: [],
  bySlug: new Map(),
  videoMap: new Map(),
};

let cache: FavoritesIndex | null = null;
let pending: Promise<FavoritesIndex> | null = null;
let lastFetchedAt = 0;
const STALE_AFTER_MS = 30_000;

type Listener = (index: FavoritesIndex) => void;
const listeners = new Set<Listener>();

function buildIndex(favorites: NicheFavoriteWithVideos[]): FavoritesIndex {
  const bySlug = new Map<string, NicheFavoriteWithVideos>();
  const videoMap = new Map<string, Array<{ niche_slug: string; niche_name: string }>>();
  for (const f of favorites) {
    bySlug.set(f.niche_slug, f);
    for (const v of f.videos) {
      const list = videoMap.get(v.video_id);
      const entry = { niche_slug: f.niche_slug, niche_name: f.niche_name };
      if (list) list.push(entry);
      else videoMap.set(v.video_id, [entry]);
    }
  }
  return { favorites, bySlug, videoMap };
}

function notify(): void {
  const current = cache ?? EMPTY;
  for (const fn of listeners) fn(current);
}

async function fetchIndex(): Promise<FavoritesIndex> {
  const res = await fetch('/api/niche-finder/favorites');
  if (!res.ok) {
    // Treat any failure as "no favorites yet" — the UI degrades to
    // the unsaved state, and the next mutation will re-attempt the
    // fetch. We don't want a stale 500 to lock the page out.
    return EMPTY;
  }
  const body = (await res.json()) as { favorites?: NicheFavoriteWithVideos[] };
  return buildIndex(body.favorites ?? []);
}

/** Force a refresh on the next read. Call after mutations. */
export function invalidateFavoritesIndex(): void {
  cache = null;
  pending = null;
  lastFetchedAt = 0;
}

/** Apply a local optimistic patch. The cache replaces itself with a
 *  rebuilt index so all listeners re-render with the new state
 *  before the network round-trip completes. */
export function applyOptimisticFavorite(row: NicheFavoriteRow): void {
  const existing = cache ?? EMPTY;
  const prior = existing.bySlug.get(row.niche_slug);
  const merged: NicheFavoriteWithVideos = {
    ...row,
    videos: prior?.videos ?? [],
  };
  const nextFavorites = prior
    ? existing.favorites.map((f) => (f.niche_slug === row.niche_slug ? merged : f))
    : [merged, ...existing.favorites];
  cache = buildIndex(nextFavorites);
  lastFetchedAt = Date.now();
  notify();
}

export function applyOptimisticUnfavorite(nicheSlug: string): void {
  const existing = cache ?? EMPTY;
  if (!existing.bySlug.has(nicheSlug)) return;
  const nextFavorites = existing.favorites.filter((f) => f.niche_slug !== nicheSlug);
  cache = buildIndex(nextFavorites);
  notify();
}

export function applyOptimisticAddVideo(
  nicheSlug: string,
  video: NicheFavoriteVideoRow,
): void {
  const existing = cache ?? EMPTY;
  const parent = existing.bySlug.get(nicheSlug);
  if (!parent) return;
  const alreadyHas = parent.videos.some((v) => v.video_id === video.video_id);
  const nextVideos = alreadyHas
    ? parent.videos.map((v) => (v.video_id === video.video_id ? video : v))
    : [video, ...parent.videos];
  const nextParent: NicheFavoriteWithVideos = { ...parent, videos: nextVideos };
  cache = buildIndex(
    existing.favorites.map((f) => (f.niche_slug === nicheSlug ? nextParent : f)),
  );
  notify();
}

export function applyOptimisticRemoveVideo(nicheSlug: string, videoId: string): void {
  const existing = cache ?? EMPTY;
  const parent = existing.bySlug.get(nicheSlug);
  if (!parent) return;
  const nextParent: NicheFavoriteWithVideos = {
    ...parent,
    videos: parent.videos.filter((v) => v.video_id !== videoId),
  };
  cache = buildIndex(
    existing.favorites.map((f) => (f.niche_slug === nicheSlug ? nextParent : f)),
  );
  notify();
}

/** Hook that returns the current favorites index. Triggers a fetch
 *  on mount if the cache is empty or stale. Re-renders any subscriber
 *  whenever the cache changes (mutation, refresh). Stale-while-
 *  revalidate: returns cached data immediately, refreshes in the
 *  background if it has aged out. */
export function useFavoritesIndex(): {
  index: FavoritesIndex;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  // Initial loading is derived purely from cache state at mount — no
  // setState-in-effect needed for the fresh-cache fast path.
  const [index, setIndex] = useState<FavoritesIndex>(cache ?? EMPTY);
  const initiallyStale = cache === null || Date.now() - lastFetchedAt > STALE_AFTER_MS;
  const [loading, setLoading] = useState(initiallyStale);

  useEffect(() => {
    const listener: Listener = (next) => setIndex(next);
    listeners.add(listener);

    // Only kick a fetch off if we deemed the cache stale at mount.
    // The fresh-cache path bails immediately so we don't set state.
    if (initiallyStale) {
      if (!pending) {
        pending = fetchIndex().then((next) => {
          cache = next;
          lastFetchedAt = Date.now();
          pending = null;
          notify();
          return next;
        });
      }
      void pending.finally(() => setLoading(false));
    }

    return () => {
      listeners.delete(listener);
    };
    // initiallyStale is computed once at mount via useState; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    invalidateFavoritesIndex();
    setLoading(true);
    const next = await fetchIndex();
    cache = next;
    lastFetchedAt = Date.now();
    notify();
    setLoading(false);
  }, []);

  return { index, loading, refresh };
}
