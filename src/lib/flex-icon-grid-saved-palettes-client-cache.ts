/**
 * Flex Icon Grid — client-side saved-palettes cache.
 *
 * Module-level cache shared by every panel instance in the browser.
 * Eliminates redundant fetches when the user opens / closes the
 * Flex Icon Grid tab repeatedly within a short window — the eager
 * fetch on every panel mount was flagged as a Phase 4.5 caveat.
 *
 * TTL: 60 seconds. Tuned to be long enough that fast tab-toggling
 * doesn't refetch, short enough that another user creating a palette
 * in the same workspace becomes visible within a minute of pressing
 * "Save". For write-through consistency within the same session,
 * `invalidate()` clears the cache so the next read fetches fresh.
 * Save / delete handlers call `invalidate()` right after a successful
 * mutation.
 *
 * Single-cache model: workspace identity is implicit — the API is
 * gated by session.ws server-side, so the cache key is effectively
 * "the current session". When the user switches workspaces (sign-out
 * + sign-in as a different user), the new session reloads the app
 * and the cache resets naturally.
 *
 * Not used during SSR: the cache exists in the browser's JS heap,
 * and Next.js doesn't share module state across requests.
 */

export interface SavedPaletteRecord {
  id: string;
  name: string;
  colors: string[];
  updated_at: string;
}

/** Stale-after window in milliseconds. */
const TTL_MS = 60_000;

interface CacheEntry {
  fetchedAt: number;
  palettes: SavedPaletteRecord[];
}

let cache: CacheEntry | null = null;
let inflight: Promise<SavedPaletteRecord[]> | null = null;

/**
 * Fetch the workspace's saved palettes, caching the result for the
 * TTL window. Concurrent callers share a single in-flight promise so
 * a rapid "mount → mount" doesn't fire two parallel requests.
 *
 * Returns `null` when the fetch fails so callers can render an
 * appropriate "could not load" state without retrying in a loop.
 */
export async function fetchSavedPalettesCached(): Promise<SavedPaletteRecord[] | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.palettes;
  }
  if (inflight) return inflight;
  inflight = (async (): Promise<SavedPaletteRecord[]> => {
    try {
      const res = await fetch('/api/thumbnails/format/flex-icon-grid/saved-palettes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { palettes: SavedPaletteRecord[] };
      cache = { fetchedAt: Date.now(), palettes: data.palettes };
      return data.palettes;
    } finally {
      inflight = null;
    }
  })();
  try {
    return await inflight;
  } catch {
    return null;
  }
}

/**
 * Clear the cache so the next read fetches fresh. Called by save /
 * delete handlers right after a successful mutation so the user
 * never sees stale data after their own write.
 */
export function invalidateSavedPalettesCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Test-only hook: drain the cache + the in-flight reference. Lets
 * a test suite isolate cache state between cases without poking at
 * module internals. Not exported via the panel surface.
 */
export function _resetSavedPalettesCacheForTests(): void {
  cache = null;
  inflight = null;
}
