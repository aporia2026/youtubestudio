/**
 * Outlier finder (mode D).
 *
 * Different shape from A/B/C — instead of returning a list of
 * niches, we return a list of *specific videos* that are
 * over-performing for their channel size. Answers "what's working
 * right now in a niche I'm already in" rather than "what niche
 * should I enter."
 *
 * The outlier score is `view_count / max(subscriber_count, 1000)`.
 * Higher = the video punches further above its channel's weight.
 * The 1000-sub floor stops a 10-sub channel with a 1M-view fluke
 * from collapsing the math.
 *
 * Pure-function scoring + a thin orchestrator that uses the
 * existing youtube-fetch wrappers.
 *
 * Fetch-on-demand — does NOT use the niche_discoveries cache
 * because the value is in seeing fresh outliers, not a stable
 * weekly ranking. The youtube-fetch cache (7-day) is what keeps
 * the quota cost reasonable on repeat lookups.
 */
import { harvestClusterSample, type FetchedChannel, type FetchedVideo } from './youtube-fetch';

/** Subscriber-count floor used when dividing views by subs. Stops
 *  micro-channels from dominating the ranking on a single fluke. */
export const OUTLIER_SUB_FLOOR = 1000;

export interface OutlierVideo {
  videoId: string;
  channelId: string;
  title: string;
  viewCount: number;
  publishedAt: string;
  durationIso: string;
  thumbnailUrl: string | null;
  channelTitle: string;
  subscriberCount: number;
  /** Computed = viewCount / max(subscriberCount, OUTLIER_SUB_FLOOR).
   *  Roughly "this video got N views per subscriber." */
  outlierScore: number;
  /** Same as outlierScore but rendered as a label for the UI:
   *    < 1  → 'underperformer'
   *    1-3  → 'normal'
   *    3-10 → 'breakout'
   *    >= 10 → 'viral'
   *  Tied to the existing competitor-summary classifyOutlier
   *  thresholds so the two surfaces agree on what counts as a
   *  breakout. */
  classification: 'underperformer' | 'normal' | 'breakout' | 'viral';
}

export interface OutlierFinderResult {
  niche: string;
  videos: OutlierVideo[];
  /** Whether the YouTube fetch returned anything. */
  fetchOk: boolean;
}

/** Compute the outlier score for one video + its channel. Pure
 *  function — exported for tests. */
export function computeOutlierScore(viewCount: number, subscriberCount: number): number {
  if (!Number.isFinite(viewCount) || viewCount < 0) return 0;
  const subs = Math.max(
    Number.isFinite(subscriberCount) && subscriberCount > 0 ? subscriberCount : 0,
    OUTLIER_SUB_FLOOR,
  );
  return viewCount / subs;
}

/** Classify the outlier score into a plain-English bucket. */
export function classifyOutlierScore(
  score: number,
): 'underperformer' | 'normal' | 'breakout' | 'viral' {
  if (!Number.isFinite(score) || score < 0) return 'underperformer';
  if (score < 1) return 'underperformer';
  if (score < 3) return 'normal';
  if (score < 10) return 'breakout';
  return 'viral';
}

/** Build OutlierVideo[] from raw YouTube fetch output. Pure — no
 *  I/O — so tests can feed fixtures directly. */
export function buildOutliers(
  videos: readonly FetchedVideo[],
  channels: readonly FetchedChannel[],
): OutlierVideo[] {
  const channelById = new Map<string, FetchedChannel>();
  for (const c of channels) channelById.set(c.id, c);
  const out: OutlierVideo[] = [];
  for (const v of videos) {
    const channel = channelById.get(v.channelId);
    const subs = channel?.subscriberCount ?? 0;
    const score = computeOutlierScore(v.viewCount, subs);
    out.push({
      videoId: v.id,
      channelId: v.channelId,
      title: v.title,
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,
      durationIso: v.durationIso,
      thumbnailUrl: v.thumbnailUrl,
      channelTitle: channel?.title ?? 'Unknown channel',
      subscriberCount: subs,
      outlierScore: Number(score.toFixed(3)),
      classification: classifyOutlierScore(score),
    });
  }
  return out.sort((a, b) => b.outlierScore - a.outlierScore);
}

export interface FindOutliersArgs {
  niche: string;
  language?: string;
  region?: string;
}

/** Fetch the top videos for a niche and rank them by outlier
 *  score. Returns a `fetchOk: false` shape rather than throwing
 *  when YouTube returns nothing — the UI surfaces an empty-state. */
export async function findOutliers(args: FindOutliersArgs): Promise<OutlierFinderResult> {
  const trimmedNiche = args.niche.trim();
  if (trimmedNiche.length === 0) {
    return { niche: '', videos: [], fetchOk: false };
  }
  const { videos, channels } = await harvestClusterSample(trimmedNiche, {
    maxVideos: 30,
    regionCode: args.region,
    relevanceLanguage: args.language,
  });
  if (videos.length === 0) {
    return { niche: trimmedNiche, videos: [], fetchOk: false };
  }
  return {
    niche: trimmedNiche,
    videos: buildOutliers(videos, channels),
    fetchOk: true,
  };
}
