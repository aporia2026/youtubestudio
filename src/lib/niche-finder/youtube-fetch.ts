/**
 * YouTube Data API v3 wrappers used by the niche finder.
 *
 * Reuses YOUTUBE_API_KEY from the existing `src/lib/youtube.ts`
 * module but adds:
 *
 *   - `search.list` (100 quota units per call) for the cluster
 *     centroid sampling.
 *   - Batched `videos.list` (1 unit per 50 IDs) for video details.
 *   - Batched `channels.list` (1 unit per 50 IDs) for channel stats.
 *   - 7-day Postgres cache keyed by request URL hash.
 *   - Per-call structured logging of quota cost (for the future
 *     quota-extension audit story).
 *
 * Every function returns either populated data or an empty result;
 * upstream HTTP failures degrade silently to empty arrays so the
 * deep-dive flow can choose to short-circuit or continue with
 * partial data rather than 500-ing the whole request.
 */
import { cacheKey, readApiCache, writeApiCache } from './db';
import { logger } from '@/lib/logger';
import { parseDurationToSeconds } from './scoring/shared';
import type { SampledChannel, SampledVideo } from './types';

/** Anything ≤ 60s reads as a YouTube Short for our purposes — the Data
 *  API doesn't expose the Shorts flag, so duration is the only signal.
 *  Kept in sync with the same constant in `outlier-filters.ts`. */
const SHORTS_MAX_SECONDS = 60;

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function apiKey(): string | null {
  return process.env.YOUTUBE_API_KEY || null;
}

interface SearchListItem {
  id?: { videoId?: string; kind?: string };
  snippet?: { channelId?: string };
}

interface VideoListItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    publishedAt?: string;
    tags?: string[];
    thumbnails?: { high?: { url: string }; maxres?: { url: string } };
  };
  statistics?: { viewCount?: string };
  contentDetails?: { duration?: string };
}

interface ChannelListItem {
  id: string;
  snippet?: { title?: string; publishedAt?: string; thumbnails?: { high?: { url: string } } };
  statistics?: { subscriberCount?: string; videoCount?: string };
}

/** Tag fetched with display data so the UI doesn't have to refetch. */
export interface FetchedVideo extends SampledVideo {
  thumbnailUrl: string | null;
}

export interface FetchedChannel extends SampledChannel {
  title: string;
  thumbnailUrl: string | null;
}

/** Common fetch shape — logs cost, caches, swallows network errors. */
async function cachedJsonGet<T>(url: string, quotaCost: number): Promise<T | null> {
  const key = cacheKey({ method: 'GET', url });

  try {
    const hit = await readApiCache<T>(key);
    if (hit !== null) return hit;
  } catch (err) {
    logger.warn('niche-finder yt-fetch: cache read failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('niche-finder yt-fetch: non-2xx', {
        status: res.status,
        quotaCost,
        url: url.replace(/key=[^&]+/, 'key=REDACTED'),
      });
      return null;
    }
    const data = (await res.json()) as T;
    try {
      await writeApiCache(key, data);
    } catch (err) {
      logger.warn('niche-finder yt-fetch: cache write failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('niche-finder yt-fetch ok', {
      quotaCost,
      endpoint: url.split('?')[0].replace(API_BASE, ''),
    });
    return data;
  } catch (err) {
    logger.warn('niche-finder yt-fetch: fetch threw', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Run search.list against YouTube for `query` and return video IDs.
 * Costs 100 quota units per page. `maxResults` is the per-page cap
 * (YouTube's own ceiling is 50). `pages` (default 1) controls how
 * many pages of results to walk via `pageToken`; total quota cost is
 * `pages * 100`. `order` defaults to `viewCount` for backwards
 * compatibility with the cluster-discovery callers; outlier-mode
 * passes `relevance` to avoid biasing toward already-big videos.
 *
 * Returns an empty array on any failure or when YOUTUBE_API_KEY
 * is not configured.
 */
export async function searchVideosForCluster(
  query: string,
  opts: {
    maxResults?: number;
    regionCode?: string;
    relevanceLanguage?: string;
    order?: 'relevance' | 'viewCount' | 'date';
    pages?: number;
  } = {},
): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const perPage = Math.min(50, Math.max(1, opts.maxResults ?? 30));
  const maxPages = Math.max(1, Math.min(10, opts.pages ?? 1));
  const order = opts.order ?? 'viewCount';

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query.trim(),
      type: 'video',
      maxResults: String(perPage),
      order,
      key,
    });
    if (opts.regionCode) params.set('regionCode', opts.regionCode);
    if (opts.relevanceLanguage) params.set('relevanceLanguage', opts.relevanceLanguage);
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${API_BASE}/search?${params.toString()}`;
    const data = await cachedJsonGet<{
      items?: SearchListItem[];
      nextPageToken?: string;
    }>(url, 100);
    if (!data?.items) break;

    for (const item of data.items) {
      const id = item?.id?.videoId;
      if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) {
        ids.push(id);
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  if (n <= 0) return [xs.slice()];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) {
    out.push(xs.slice(i, i + n));
  }
  return out;
}

/**
 * Batch-fetch full video details for up to N video IDs. Costs 1
 * quota unit per batch of 50. Returns a `FetchedVideo[]` ordered to
 * match the input IDs as best we can (YouTube doesn't guarantee
 * input order, but we re-sort below).
 */
export async function fetchVideosBatch(videoIds: readonly string[]): Promise<FetchedVideo[]> {
  const key = apiKey();
  if (!key) return [];
  const unique = Array.from(new Set(videoIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (unique.length === 0) return [];

  const byId = new Map<string, FetchedVideo>();
  for (const batch of chunk(unique, 50)) {
    const params = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
      maxResults: '50',
      key,
    });
    const url = `${API_BASE}/videos?${params.toString()}`;
    const data = await cachedJsonGet<{ items?: VideoListItem[] }>(url, 1);
    for (const item of data?.items ?? []) {
      byId.set(item.id, {
        id: item.id,
        channelId: item.snippet?.channelId ?? '',
        title: item.snippet?.title ?? '',
        description: item.snippet?.description ?? '',
        viewCount: parseInt(item.statistics?.viewCount ?? '0', 10) || 0,
        publishedAt: item.snippet?.publishedAt ?? '',
        durationIso: item.contentDetails?.duration ?? 'PT0S',
        tags: item.snippet?.tags ?? [],
        thumbnailUrl:
          item.snippet?.thumbnails?.maxres?.url ??
          item.snippet?.thumbnails?.high?.url ??
          null,
      });
    }
  }

  // Return in input order so callers can rely on "top-views first"
  // from the search.list ordering.
  const out: FetchedVideo[] = [];
  for (const id of unique) {
    const v = byId.get(id);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Batch-fetch channel stats for up to N channel IDs. Costs 1 quota
 * unit per batch of 50.
 */
export async function fetchChannelsBatch(channelIds: readonly string[]): Promise<FetchedChannel[]> {
  const key = apiKey();
  if (!key) return [];
  const unique = Array.from(new Set(channelIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (unique.length === 0) return [];

  const byId = new Map<string, FetchedChannel>();
  for (const batch of chunk(unique, 50)) {
    const params = new URLSearchParams({
      part: 'snippet,statistics',
      id: batch.join(','),
      maxResults: '50',
      key,
    });
    const url = `${API_BASE}/channels?${params.toString()}`;
    const data = await cachedJsonGet<{ items?: ChannelListItem[] }>(url, 1);
    for (const item of data?.items ?? []) {
      byId.set(item.id, {
        id: item.id,
        title: item.snippet?.title ?? '',
        subscriberCount: parseInt(item.statistics?.subscriberCount ?? '0', 10) || 0,
        videoCount: parseInt(item.statistics?.videoCount ?? '0', 10) || 0,
        createdAt: item.snippet?.publishedAt ?? null,
        thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? null,
      });
    }
  }

  const out: FetchedChannel[] = [];
  for (const id of unique) {
    const c = byId.get(id);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Convenience: given a query, fetch its top-N videos plus the
 * unique channels that authored them, in one call. This is what the
 * cluster-harvest helper consumes.
 *
 * `excludeShorts` defaults to `true`. When set, videos with a parsed
 * duration ≤ 60s are dropped after fetch, and channels that contributed
 * only Shorts to the sample are also dropped. The operator's stated
 * focus is long-form video, so this is the correct default; pass
 * `excludeShorts: false` from callers that genuinely want everything
 * (e.g. a future "include shorts" toggle).
 *
 * YouTube's `videoDuration` enum (`short` < 4 min, `medium` 4-20 min,
 * `long` > 20 min) doesn't map cleanly to "anything but Shorts" — the
 * `short` bucket includes 60s-4min content the operator wants to keep —
 * so we filter post-fetch on the exact ≤60s threshold instead.
 */
export async function harvestClusterSample(
  query: string,
  opts: {
    maxVideos?: number;
    regionCode?: string;
    relevanceLanguage?: string;
    order?: 'relevance' | 'viewCount' | 'date';
    pages?: number;
    excludeShorts?: boolean;
  } = {},
): Promise<{ videos: FetchedVideo[]; channels: FetchedChannel[] }> {
  const videoIds = await searchVideosForCluster(query, {
    maxResults: opts.maxVideos ?? 30,
    regionCode: opts.regionCode,
    relevanceLanguage: opts.relevanceLanguage,
    order: opts.order,
    pages: opts.pages,
  });
  if (videoIds.length === 0) return { videos: [], channels: [] };

  const fetchedVideos = await fetchVideosBatch(videoIds);
  const videos = opts.excludeShorts === false
    ? fetchedVideos
    : fetchedVideos.filter((v) => !isShort(v.durationIso));
  const uniqueChannelIds = Array.from(
    new Set(videos.map((v) => v.channelId).filter((id) => id.length > 0)),
  );
  const channels = await fetchChannelsBatch(uniqueChannelIds);
  return { videos, channels };
}

/** True when the parsed duration is ≤ SHORTS_MAX_SECONDS. 0/missing
 *  durations are *not* treated as Shorts — we'd rather keep a video we
 *  can't classify than silently drop it. */
export function isShort(durationIso: string): boolean {
  const seconds = parseDurationToSeconds(durationIso);
  return seconds > 0 && seconds <= SHORTS_MAX_SECONDS;
}
