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

/** Number of search.list pages walked per variant. Total quota per
 *  outlier search = OUTLIER_QUERY_PAGES * 100 * #variants. Tuned to
 *  balance coverage vs. YouTube's default 10k daily quota. */
const OUTLIER_QUERY_PAGES = 2;

/** Per-page result cap. YouTube's own ceiling is 50. */
const OUTLIER_PER_PAGE = 50;

/**
 * Build a small set of query variants for one niche. Variants are
 * content-shape-neutral on purpose: a bare query, a "best X" lens
 * for top-recommendation content, and a current-year lens for recent
 * activity. Returned variants are deduped so a niche that already
 * contains "best" or the current year doesn't double up.
 *
 * Exported for tests.
 */
export function buildOutlierQueryVariants(niche: string): string[] {
  const base = niche.trim();
  if (base.length === 0) return [];
  const lower = base.toLowerCase();
  const currentYear = String(new Date().getFullYear());
  const out: string[] = [base];
  if (!lower.startsWith('best ')) out.push(`best ${base}`);
  if (!lower.includes(currentYear)) out.push(`${base} ${currentYear}`);
  return out;
}

/** Fetch top videos for a niche across several query variants and
 *  rank them by outlier score. Variants are merged on videoId so the
 *  same video surfacing under multiple queries doesn't double-count.
 *  Returns `fetchOk: false` rather than throwing when no variant
 *  produced results; the UI surfaces an empty-state. */
export async function findOutliers(args: FindOutliersArgs): Promise<OutlierFinderResult> {
  const trimmedNiche = args.niche.trim();
  if (trimmedNiche.length === 0) {
    return { niche: '', videos: [], fetchOk: false };
  }

  const variants = buildOutlierQueryVariants(trimmedNiche);
  const videoById = new Map<string, FetchedVideo>();
  const channelById = new Map<string, FetchedChannel>();
  for (const variant of variants) {
    const { videos, channels } = await harvestClusterSample(variant, {
      maxVideos: OUTLIER_PER_PAGE,
      pages: OUTLIER_QUERY_PAGES,
      order: 'relevance',
      regionCode: args.region,
      relevanceLanguage: args.language,
    });
    for (const v of videos) if (!videoById.has(v.id)) videoById.set(v.id, v);
    for (const c of channels) if (!channelById.has(c.id)) channelById.set(c.id, c);
  }

  if (videoById.size === 0) {
    return { niche: trimmedNiche, videos: [], fetchOk: false };
  }
  return {
    niche: trimmedNiche,
    videos: buildOutliers(
      Array.from(videoById.values()),
      Array.from(channelById.values()),
    ),
    fetchOk: true,
  };
}
