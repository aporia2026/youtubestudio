/**
 * Flex Icon Grid — server-side custom font byte cache.
 *
 * Per-process LRU keyed by R2 download URL. Composer reads through
 * this cache so a popular font isn't re-downloaded on every render
 * within the same Lambda instance (Phase 4.7 caveat fix).
 *
 * Cache semantics
 *  - Stores the fetched TTF/OTF/WOFF bytes in memory (not the temp
 *    file path). Each render still writes its own temp file from the
 *    cached buffer so cleanup is straightforward — disk state doesn't
 *    survive across renders.
 *  - Capacity: `MAX_ENTRIES` (default 20). Eviction is LRU by access
 *    time; the oldest non-pinned entry leaves first.
 *  - Bytes cap: typical fonts run 50–500 KB, so 20 × 500 KB ≈ 10 MB
 *    worst case. Lambda instances default to 1 GB+ RAM, so the
 *    bound is comfortable; tighten by lowering MAX_ENTRIES if a
 *    workspace habitually uploads many large fonts.
 *
 * Coalescing
 *  - Concurrent reads for the same URL share a single in-flight
 *    fetch promise. Stops a thundering-herd burst on the first
 *    render that references a new font.
 *
 * Tests
 *  - `_resetFontByteCacheForTests()` clears the cache + the in-flight
 *    map. Test-only — never called by production code.
 */

const MAX_ENTRIES = 20;

interface CacheEntry {
  bytes: Buffer;
  atime: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Buffer>>();

/**
 * Read-through cache: return the bytes for `url`, fetching via the
 * provided `fetcher` on miss. The fetcher is typically the same
 * SSRF-guarded R2 fetcher the rest of the composer uses.
 */
export async function fetchFontBytesCached(
  url: string,
  fetcher: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const hit = cache.get(url);
  if (hit) {
    hit.atime = Date.now();
    return hit.bytes;
  }
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const bytes = await fetcher(url);
      // Capacity guard. Evict the oldest entry by access time before
      // inserting. Done at insert time rather than via a periodic
      // sweep so the LRU window updates without timers.
      if (cache.size >= MAX_ENTRIES) {
        let oldestUrl: string | null = null;
        let oldestAtime = Number.POSITIVE_INFINITY;
        for (const [u, entry] of cache) {
          if (entry.atime < oldestAtime) {
            oldestAtime = entry.atime;
            oldestUrl = u;
          }
        }
        if (oldestUrl) cache.delete(oldestUrl);
      }
      cache.set(url, { bytes, atime: Date.now() });
      return bytes;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

/** Test-only: drain the cache + in-flight map so a test suite can
 *  isolate state between cases. Production code never calls this. */
export function _resetFontByteCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Diagnostic — exposed for logs / health checks. */
export function getFontCacheStats(): { entries: number; inflight: number; max: number } {
  return { entries: cache.size, inflight: inflight.size, max: MAX_ENTRIES };
}
