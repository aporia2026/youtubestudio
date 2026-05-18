/**
 * General outlier search — three sources that bypass the typed-niche
 * flow.
 *
 *   A. 'breakouts' — operator's own channel-breakout fires.
 *      Source: `video_breakout_fires` (populated by the detect-breakouts cron).
 *      Workspace-scoped. Free (re-fetches metadata via 1-2 quota units).
 *
 *   B. 'trending'  — YouTube's regional trending list.
 *      Source: `videos.list?chart=mostPopular`. Global (not workspace-
 *      specific). 1 quota unit. Most results will be normal/under-
 *      performer in outlier-score terms — these are mega-channels —
 *      but useful for "what's resonating right now."
 *
 *   C. 'favorites' — outliers across the operator's favorited niches.
 *      Source: existing `findOutliers` orchestrator, iterated over the
 *      first N non-placeholder favorites. The underlying calls go
 *      through the 7-day youtube-fetch cache so repeat clicks are
 *      cheap; cold first click on N new niches burns ~250 quota each.
 *
 * All three return `OutlierFinderResult` so the existing /outliers
 * route and OutlierCard UI render them with no changes.
 */
import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';
import {
  buildOutliers,
  findOutliers,
  type OutlierFinderResult,
  type OutlierVideo,
} from './outliers';
import {
  fetchChannelsBatch,
  fetchVideosBatch,
  isShort,
  passesLanguageFilter,
  type FetchedVideo,
} from './youtube-fetch';

export type GeneralOutlierSource = 'breakouts' | 'trending' | 'favorites';

/** Max favorited niches we scan in source='favorites' mode per click.
 *  Each adds ~200-300 YouTube quota units on a cold call, so the cap
 *  keeps total cost bounded. The cache makes repeat clicks cheap. */
export const FAVORITES_SCAN_CAP = 3;

/** Max videos returned across all sources. Keeps the response small
 *  and matches the existing OutlierCard list's "scannable" feel. */
export const RESULT_CAP = 50;

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

export async function dispatchGeneralOutliers(args: {
  workspaceId: string;
  source: GeneralOutlierSource;
  /** Optional region for source='trending'. Defaults to 'US'. */
  regionCode?: string;
  /** Optional language (ISO 639-1, e.g. 'en'). When set, the post-fetch
   *  language filter drops videos that don't match. Defaults to 'en'
   *  upstream of this dispatcher. */
  language?: string;
}): Promise<OutlierFinderResult> {
  switch (args.source) {
    case 'breakouts':
      return findMyChannelBreakouts(args.workspaceId, args.language);
    case 'trending':
      return findYouTubeTrending(args.regionCode ?? 'US', args.language);
    case 'favorites':
      return findOutliersAcrossFavorites(args.workspaceId, args.language);
  }
}

// ---------------------------------------------------------------------------
// A. My channel breakouts.
// ---------------------------------------------------------------------------

interface BreakoutFireRow {
  youtube_video_id: string;
  fired_at: string;
}

/** Pull the last 90 days of breakout fires for this workspace, then
 *  re-fetch fresh metadata + channel stats so the outlier score
 *  reflects current view counts (not the snapshot at fire time). */
export async function findMyChannelBreakouts(
  workspaceId: string,
  language?: string,
): Promise<OutlierFinderResult> {
  const { rows } = await sql<BreakoutFireRow>`
    SELECT youtube_video_id, fired_at::text AS fired_at
      FROM video_breakout_fires
     WHERE workspace_id = ${workspaceId}::uuid
       AND fired_at > NOW() - INTERVAL '90 days'
     ORDER BY fired_at DESC
     LIMIT ${RESULT_CAP}
  `;
  if (rows.length === 0) {
    return { niche: 'My channel breakouts', videos: [], fetchOk: true };
  }

  const videoIds = rows.map((r) => r.youtube_video_id);
  const fetched = await fetchVideosBatch(videoIds);
  if (fetched.length === 0) {
    return { niche: 'My channel breakouts', videos: [], fetchOk: false };
  }
  // Operator's focus is long-form; Shorts they post still surface in
  // their own breakout-fires table but shouldn't dominate the niche-
  // finder discovery surface. Match harvestClusterSample's default.
  let videos = fetched.filter((v) => !isShort(v.durationIso));
  if (language) {
    videos = videos.filter((v) => passesLanguageFilter(v, language));
  }
  const channelIds = Array.from(new Set(videos.map((v) => v.channelId).filter((id) => id.length > 0)));
  const channels = await fetchChannelsBatch(channelIds);

  const outliers = buildOutliers(videos, channels);
  return {
    niche: `My channel breakouts (${rows.length} fired in last 90d)`,
    videos: outliers,
    fetchOk: true,
  };
}

// ---------------------------------------------------------------------------
// B. YouTube trending.
// ---------------------------------------------------------------------------

interface TrendingVideoItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    publishedAt?: string;
    tags?: string[];
    thumbnails?: { high?: { url: string }; maxres?: { url: string } };
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  statistics?: { viewCount?: string };
  contentDetails?: { duration?: string };
}

/** Pull YouTube's regional trending chart and reshape into OutlierVideo[].
 *  Bypasses the 7-day youtube-fetch cache because trending is high-
 *  churn — operator wants the actual current list. We still cache
 *  in-memory for 15 minutes via a module-level Map keyed by (region,
 *  language) — trending is region-specific but the language-filtered
 *  view of it is a per-operator slice. */
const TRENDING_CACHE = new Map<string, { fetchedAt: number; result: OutlierFinderResult }>();
const TRENDING_TTL_MS = 15 * 60 * 1000;

export async function findYouTubeTrending(
  regionCode: string,
  language?: string,
): Promise<OutlierFinderResult> {
  const region = (regionCode || 'US').toUpperCase().slice(0, 2);
  const lang = (language || '').toLowerCase().split('-')[0];
  const cacheKey = `${region}|${lang}`;
  const cached = TRENDING_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TRENDING_TTL_MS) {
    return cached.result;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { niche: `YouTube trending — ${region}`, videos: [], fetchOk: false };
  }
  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    chart: 'mostPopular',
    regionCode: region,
    maxResults: '50',
    key: apiKey,
  });
  const url = `${API_BASE}/videos?${params.toString()}`;

  let trendingItems: TrendingVideoItem[] = [];
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('outliers-general: trending fetch non-2xx', { status: res.status, region });
      return { niche: `YouTube trending — ${region}`, videos: [], fetchOk: false };
    }
    const data = (await res.json()) as { items?: TrendingVideoItem[] };
    trendingItems = data.items ?? [];
  } catch (err) {
    logger.warn('outliers-general: trending fetch threw', {
      region,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { niche: `YouTube trending — ${region}`, videos: [], fetchOk: false };
  }

  // Convert to FetchedVideo shape so buildOutliers can chew on it.
  // Drop Shorts in the same pass — YouTube's trending chart is heavily
  // shorts-biased in most regions and the operator's focus is long-form.
  const fetchedVideos: FetchedVideo[] = [];
  for (const item of trendingItems) {
    if (!item.id) continue;
    const durationIso = item.contentDetails?.duration ?? 'PT0S';
    if (isShort(durationIso)) continue;
    fetchedVideos.push({
      id: item.id,
      channelId: item.snippet?.channelId ?? '',
      title: item.snippet?.title ?? '',
      description: item.snippet?.description ?? '',
      viewCount: parseInt(item.statistics?.viewCount ?? '0', 10) || 0,
      publishedAt: item.snippet?.publishedAt ?? '',
      durationIso,
      tags: item.snippet?.tags ?? [],
      thumbnailUrl:
        item.snippet?.thumbnails?.maxres?.url ?? item.snippet?.thumbnails?.high?.url ?? null,
      defaultLanguage: item.snippet?.defaultLanguage ?? null,
      defaultAudioLanguage: item.snippet?.defaultAudioLanguage ?? null,
    });
  }

  // Trending list comes from mega-channels — their subscriber count
  // makes them rarely "breakouts" in views÷subs terms, but we still
  // surface the score honestly so the operator can spot the rare
  // genuine outlier (small channel that's gone trending).
  const filteredVideos = lang
    ? fetchedVideos.filter((v) => passesLanguageFilter(v, lang))
    : fetchedVideos;
  const channelIds = Array.from(
    new Set(filteredVideos.map((v) => v.channelId).filter((id) => id.length > 0)),
  );
  const channels = await fetchChannelsBatch(channelIds);

  const outliers = buildOutliers(filteredVideos, channels);
  const result: OutlierFinderResult = {
    niche: `YouTube trending — ${region}`,
    videos: outliers,
    fetchOk: true,
  };
  TRENDING_CACHE.set(cacheKey, { fetchedAt: Date.now(), result });
  return result;
}

// ---------------------------------------------------------------------------
// C. Across favorited niches.
// ---------------------------------------------------------------------------

interface FavoriteForScan {
  niche_slug: string;
  niche_name: string;
}

/** Iterate the operator's first N non-placeholder favorites, run the
 *  existing per-niche outlier search on each, merge + dedupe. */
export async function findOutliersAcrossFavorites(
  workspaceId: string,
  language?: string,
): Promise<OutlierFinderResult> {
  // Read niche names directly — bypass listFavorites to avoid pulling
  // every column when we only need slug + name. We also filter out
  // placeholder-score favorites at the SQL level so the cap counts
  // real niches.
  const { rows: favorites } = await sql<FavoriteForScan>`
    SELECT niche_slug, niche_name
      FROM niche_favorites
     WHERE workspace_id = ${workspaceId}::uuid
       AND deleted_at IS NULL
       -- Exclude placeholder-scores favorites (combined=0 + lowest labels):
       -- they have no real signal so running a niche outlier search on the
       -- raw name would produce noise. Match the same shape as
       -- isPlaceholderScores() in favorites.ts.
       AND COALESCE((scores->>'combined')::numeric, 0) <> 0
     ORDER BY updated_at DESC
     LIMIT ${FAVORITES_SCAN_CAP}
  `;

  if (favorites.length === 0) {
    return {
      niche: 'Across your favorited niches',
      videos: [],
      fetchOk: true,
    };
  }

  // Parallelize the per-niche fetches. The youtube-fetch cache is the
  // serialization point if two requests collide on the same niche.
  const perNiche = await Promise.all(
    favorites.map(async (f) => {
      try {
        const r = await findOutliers({ niche: f.niche_name, language });
        return { name: f.niche_name, videos: r.videos };
      } catch (err) {
        logger.warn('outliers-general: per-favorite findOutliers failed', {
          workspace_id: workspaceId,
          niche_slug: f.niche_slug,
          detail: err instanceof Error ? err.message : String(err),
        });
        return { name: f.niche_name, videos: [] };
      }
    }),
  );

  // Merge + dedupe by videoId, keeping highest outlier score on collision.
  const byId = new Map<string, OutlierVideo>();
  for (const slice of perNiche) {
    for (const v of slice.videos) {
      const prev = byId.get(v.videoId);
      if (!prev || v.outlierScore > prev.outlierScore) byId.set(v.videoId, v);
    }
  }

  const merged = Array.from(byId.values())
    .sort((a, b) => b.outlierScore - a.outlierScore)
    .slice(0, RESULT_CAP);

  return {
    niche: `Across your favorited niches (${favorites.length}: ${favorites.map((f) => f.niche_name).join(', ')})`,
    videos: merged,
    fetchOk: true,
  };
}

