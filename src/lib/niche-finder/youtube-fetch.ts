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
import type { SampledChannel, SampledVideo } from './types';

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
 * Run a single search.list call against YouTube for `query` and
 * return the top video IDs. Costs 100 quota units. Caps at the
 * caller-specified `maxResults` (default 30), which is also the
 * YouTube max per page; we never paginate so 1 call = 100 units.
 *
 * Returns an empty array on any failure or when YOUTUBE_API_KEY
 * is not configured.
 */
export async function searchVideosForCluster(
  query: string,
  opts: { maxResults?: number; regionCode?: string; relevanceLanguage?: string } = {},
): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const params = new URLSearchParams({
    part: 'snippet',
    q: query.trim(),
    type: 'video',
    maxResults: String(Math.min(50, Math.max(1, opts.maxResults ?? 30))),
    order: 'viewCount',
    key,
  });
  if (opts.regionCode) params.set('regionCode', opts.regionCode);
  if (opts.relevanceLanguage) params.set('relevanceLanguage', opts.relevanceLanguage);

  const url = `${API_BASE}/search?${params.toString()}`;
  const data = await cachedJsonGet<{ items?: SearchListItem[] }>(url, 100);
  if (!data?.items) return [];

  const ids: string[] = [];
  for (const item of data.items) {
    const id = item?.id?.videoId;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) {
      ids.push(id);
    }
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
 */
export async function harvestClusterSample(
  query: string,
  opts: { maxVideos?: number; regionCode?: string; relevanceLanguage?: string } = {},
): Promise<{ videos: FetchedVideo[]; channels: FetchedChannel[] }> {
  const videoIds = await searchVideosForCluster(query, {
    maxResults: opts.maxVideos ?? 30,
    regionCode: opts.regionCode,
    relevanceLanguage: opts.relevanceLanguage,
  });
  if (videoIds.length === 0) return { videos: [], channels: [] };

  const videos = await fetchVideosBatch(videoIds);
  const uniqueChannelIds = Array.from(
    new Set(videos.map((v) => v.channelId).filter((id) => id.length > 0)),
  );
  const channels = await fetchChannelsBatch(uniqueChannelIds);
  return { videos, channels };
}
