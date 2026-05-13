/**
 * Filter + sort machinery for the outlier finder (mode D).
 *
 * Pure functions only — every filter and every preset is
 * deterministic and unit-tested. The UI applies these client-side
 * over the already-fetched OutlierVideo array, so dialling filters
 * doesn't re-burn YouTube quota.
 *
 * Filter dimensions (8):
 *   1. format        — short / normal / long (YouTube mid-roll
 *                      eligibility at 8m is the long-form floor;
 *                      shorts are ≤ 60s).
 *   2. channelSize   — tiny / small / mid / large by subscriber count.
 *   3. minViews      — minimum total view count.
 *   4. publishedWithinDays — days since publish (0 = no cap).
 *   5. minOutlier    — minimum outlier score (0=all, 1=normal+,
 *                      3=breakout+, 10=viral only).
 *   6. titleLength   — punchy / medium / descriptive.
 *   7. consistentWinnersOnly — channel has ≥ 3 videos in the
 *                      already-fetched outlier set.
 *   8. sortBy        — outlier (default) / views / subsDesc /
 *                      subsAsc / newest / titleShortest.
 *
 * The "consistent winners" signal is the most subtle: it's a flag
 * derived AT FILTER TIME from the full result set, not from any
 * single video. It captures channels that consistently produce
 * outliers (signal) vs single-hit one-off flukes (noise).
 */
import { parseDurationToSeconds } from './scoring/shared';
import type { OutlierVideo } from './outliers';

// ---------------------------------------------------------------------------
// Bucket types + helpers
// ---------------------------------------------------------------------------

export type VideoFormat = 'short' | 'normal' | 'long';
export type ChannelSize = 'tiny' | 'small' | 'mid' | 'large';
export type TitleLength = 'punchy' | 'medium' | 'descriptive';
export type SortBy = 'outlier' | 'views' | 'subsDesc' | 'subsAsc' | 'newest' | 'titleShortest';

/** Mid-roll floor (matches scoring/monetization.ts). */
const MID_ROLL_FLOOR_SECONDS = 8 * 60;

/** YouTube Partner Program minimum subscriber count — one of the
 *  two gates that allow a channel to monetize (the other is 4,000
 *  watch hours, which the public API doesn't expose). The Data API
 *  doesn't publish per-video monetization status for channels we
 *  don't own, so this is a *heuristic*, not ground truth. */
export const YPP_MIN_SUBSCRIBERS = 1000;

/** Shorts cap. Anything ≤ 60s reads as a YouTube Short for our purposes;
 *  the durationIso is the only signal we have here (the Data API doesn't
 *  cleanly expose the Shorts flag). */
const SHORTS_MAX_SECONDS = 60;

export function bucketDuration(durationIso: string): VideoFormat {
  const seconds = parseDurationToSeconds(durationIso);
  if (seconds > 0 && seconds <= SHORTS_MAX_SECONDS) return 'short';
  if (seconds >= MID_ROLL_FLOOR_SECONDS) return 'long';
  return 'normal';
}

export function bucketChannelSize(subscriberCount: number): ChannelSize {
  if (!Number.isFinite(subscriberCount) || subscriberCount < 10_000) return 'tiny';
  if (subscriberCount < 100_000) return 'small';
  if (subscriberCount < 1_000_000) return 'mid';
  return 'large';
}

/** Punchy ≤ 40 chars, descriptive > 70, otherwise medium. Tuned to
 *  match the "short hook" titling pattern (vs descriptive SEO
 *  titles). */
export function bucketTitleLength(title: string): TitleLength {
  const n = typeof title === 'string' ? title.trim().length : 0;
  if (n <= 40) return 'punchy';
  if (n > 70) return 'descriptive';
  return 'medium';
}

/** Channels with ≥ N videos in the supplied set. Returned as a Set
 *  of channelIds so a downstream filter can do O(1) membership
 *  checks. Default threshold is 3 — two hits is noise, three is
 *  signal. */
export function computeConsistentWinners(
  videos: readonly OutlierVideo[],
  threshold = 3,
): Set<string> {
  const counts = new Map<string, number>();
  for (const v of videos) {
    counts.set(v.channelId, (counts.get(v.channelId) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [channelId, n] of counts.entries()) {
    if (n >= threshold) out.add(channelId);
  }
  return out;
}

/** Days between an ISO timestamp and now. Returns Infinity for
 *  malformed input so "any age" filters don't accidentally exclude
 *  the row. */
function ageDays(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Filter object
// ---------------------------------------------------------------------------

export interface OutlierFilters {
  /** Set of formats to include. Empty/undefined = all. */
  formats?: ReadonlyArray<VideoFormat>;
  /** Set of channel sizes to include. Empty/undefined = all. */
  channelSizes?: ReadonlyArray<ChannelSize>;
  /** Minimum total view count. 0 / undefined = no cap. */
  minViews?: number;
  /** Only videos published within the last N days. 0 / undefined = all. */
  publishedWithinDays?: number;
  /** Minimum outlier score. 0 / undefined = all. */
  minOutlierScore?: number;
  /** Set of title-length buckets to include. */
  titleLengths?: ReadonlyArray<TitleLength>;
  /** Only show videos from channels with ≥3 hits in the set. */
  consistentWinnersOnly?: boolean;
  /** Restrict to videos that *plausibly* monetize: channel meets
   *  the YPP subscriber minimum (1K) AND duration clears the
   *  mid-roll floor (8 min). Heuristic; see `isLikelyMonetized`. */
  likelyMonetized?: boolean;
  /** Sort order — default is outlier-score descending. */
  sortBy?: SortBy;

  // -- Precise numeric ranges. When set on a given dimension, the
  // range supersedes the corresponding chip-based field above. Pairs
  // are [min, max] inclusive in the dimension's natural unit. The
  // OutlierFilterBar clears the chip field when a slider is touched
  // and clears the range when a chip is clicked, so the two never
  // contradict in normal use.

  /** Video duration range in seconds. Supersedes `formats`. */
  durationRangeSec?: readonly [number, number];
  /** Channel subscriber-count range. Supersedes `channelSizes`. */
  subsRange?: readonly [number, number];
  /** Total view-count range. Supersedes `minViews`. */
  viewsRange?: readonly [number, number];
  /** Published-age range in days (0 = brand new). Supersedes
   *  `publishedWithinDays`. */
  publishedAgeRangeDays?: readonly [number, number];
  /** Outlier-score range (views/subs). Supersedes `minOutlierScore`. */
  outlierScoreRange?: readonly [number, number];
  /** Title-length range in characters. Supersedes `titleLengths`. */
  titleLengthRange?: readonly [number, number];
}

// -- Slider domain ceilings. The full range [0, ceiling] reads as
// "no filter" and the UI elides the field. Public so the slider
// component and tests share one source of truth.
export const DURATION_RANGE_MAX_SEC = 14_400; // 4 hours
export const SUBS_RANGE_MAX = 50_000_000; // 50M subs
export const VIEWS_RANGE_MAX = 500_000_000; // 500M views
export const PUBLISHED_AGE_RANGE_MAX_DAYS = 1825; // 5 years
export const OUTLIER_SCORE_RANGE_MAX = 100; // 100×
export const TITLE_LENGTH_RANGE_MAX = 200; // 200 chars

/** Returns the range if it actually narrows the dimension, else null.
 *  A range is "narrowing" when it's not the full [0, ceiling] sweep.
 *  Pure helper, exported for tests. */
export function activeRange(
  range: readonly [number, number] | undefined,
  ceiling: number,
): readonly [number, number] | null {
  if (!range) return null;
  const [lo, hi] = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo <= 0 && hi >= ceiling) return null;
  return [Math.max(0, lo), Math.min(ceiling, hi)];
}

/** Heuristic — true when a video is *plausibly* monetized. The
 *  YouTube Data API doesn't publish per-video monetization status
 *  for channels we don't own, so we approximate with two visible
 *  prerequisites:
 *
 *    1. Channel meets the YPP subscriber minimum (≥ 1,000 subs).
 *    2. Duration clears the mid-roll ad floor (≥ 8 minutes), the
 *       point at which YouTube allows in-stream ads other than
 *       a pre/post-roll.
 *
 *  This will mis-label channels that meet both gates but have
 *  opted out of monetization, and channels that monetize without
 *  mid-rolls (e.g. sponsorship-only Shorts creators). Treat as a
 *  filter signal, not a definitive answer. */
export function isLikelyMonetized(video: {
  subscriberCount: number;
  durationIso: string;
}): boolean {
  if (!Number.isFinite(video.subscriberCount)) return false;
  if (video.subscriberCount < YPP_MIN_SUBSCRIBERS) return false;
  const seconds = parseDurationToSeconds(video.durationIso);
  return seconds >= MID_ROLL_FLOOR_SECONDS;
}

export const DEFAULT_FILTERS: OutlierFilters = Object.freeze({
  sortBy: 'outlier',
});

// ---------------------------------------------------------------------------
// Core filter+sort
// ---------------------------------------------------------------------------

/** Apply filters + sort. Pure — returns a new array, never mutates.
 *
 *  `nowMs` is injected so tests are deterministic; defaults to
 *  Date.now() in production. */
export function filterAndSortOutliers(
  videos: readonly OutlierVideo[],
  filters: OutlierFilters,
  nowMs: number = Date.now(),
): OutlierVideo[] {
  if (!Array.isArray(videos) || videos.length === 0) return [];

  // Range fields take precedence over their chip-based counterparts.
  // When a range is set and actually narrows the dimension, the
  // chip set for that dimension is ignored entirely.
  const durationRange = activeRange(filters.durationRangeSec, DURATION_RANGE_MAX_SEC);
  const subsRange = activeRange(filters.subsRange, SUBS_RANGE_MAX);
  const viewsRange = activeRange(filters.viewsRange, VIEWS_RANGE_MAX);
  const publishedRange = activeRange(filters.publishedAgeRangeDays, PUBLISHED_AGE_RANGE_MAX_DAYS);
  const outlierRange = activeRange(filters.outlierScoreRange, OUTLIER_SCORE_RANGE_MAX);
  const titleRange = activeRange(filters.titleLengthRange, TITLE_LENGTH_RANGE_MAX);

  const formats = durationRange ? null : setOrNull(filters.formats);
  const sizes = subsRange ? null : setOrNull(filters.channelSizes);
  const titleBuckets = titleRange ? null : setOrNull(filters.titleLengths);
  const minViews =
    viewsRange === null && Number.isFinite(filters.minViews) && (filters.minViews ?? 0) > 0
      ? filters.minViews!
      : 0;
  const minOutlier =
    outlierRange === null &&
    Number.isFinite(filters.minOutlierScore) &&
    (filters.minOutlierScore ?? 0) > 0
      ? filters.minOutlierScore!
      : 0;
  const windowDays =
    publishedRange === null &&
    Number.isFinite(filters.publishedWithinDays) &&
    (filters.publishedWithinDays ?? 0) > 0
      ? filters.publishedWithinDays!
      : 0;
  const consistentWinners = filters.consistentWinnersOnly ? computeConsistentWinners(videos) : null;

  const filtered = videos.filter((v) => {
    if (formats && !formats.has(bucketDuration(v.durationIso))) return false;
    if (sizes && !sizes.has(bucketChannelSize(v.subscriberCount))) return false;
    if (titleBuckets && !titleBuckets.has(bucketTitleLength(v.title))) return false;
    if (minViews > 0 && v.viewCount < minViews) return false;
    if (minOutlier > 0 && v.outlierScore < minOutlier) return false;
    if (windowDays > 0 && ageDays(v.publishedAt, nowMs) > windowDays) return false;
    if (consistentWinners && !consistentWinners.has(v.channelId)) return false;
    if (filters.likelyMonetized && !isLikelyMonetized(v)) return false;

    if (durationRange) {
      const sec = parseDurationToSeconds(v.durationIso);
      if (sec < durationRange[0] || sec > durationRange[1]) return false;
    }
    if (subsRange) {
      if (v.subscriberCount < subsRange[0] || v.subscriberCount > subsRange[1]) return false;
    }
    if (viewsRange) {
      if (v.viewCount < viewsRange[0] || v.viewCount > viewsRange[1]) return false;
    }
    if (publishedRange) {
      const age = ageDays(v.publishedAt, nowMs);
      if (age < publishedRange[0] || age > publishedRange[1]) return false;
    }
    if (outlierRange) {
      if (v.outlierScore < outlierRange[0] || v.outlierScore > outlierRange[1]) return false;
    }
    if (titleRange) {
      const n = typeof v.title === 'string' ? v.title.trim().length : 0;
      if (n < titleRange[0] || n > titleRange[1]) return false;
    }

    return true;
  });

  return sortVideos(filtered, filters.sortBy ?? 'outlier');
}

function setOrNull<T>(xs: ReadonlyArray<T> | undefined): Set<T> | null {
  if (!xs || xs.length === 0) return null;
  return new Set(xs);
}

function sortVideos(videos: readonly OutlierVideo[], sortBy: SortBy): OutlierVideo[] {
  const arr = videos.slice();
  switch (sortBy) {
    case 'views':
      arr.sort((a, b) => b.viewCount - a.viewCount);
      break;
    case 'subsDesc':
      arr.sort((a, b) => b.subscriberCount - a.subscriberCount);
      break;
    case 'subsAsc':
      arr.sort((a, b) => a.subscriberCount - b.subscriberCount);
      break;
    case 'newest':
      arr.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      break;
    case 'titleShortest':
      arr.sort((a, b) => a.title.length - b.title.length);
      break;
    case 'outlier':
    default:
      arr.sort((a, b) => b.outlierScore - a.outlierScore);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Built-in smart presets
// ---------------------------------------------------------------------------

/** A built-in preset that's ready to one-click apply. The
 *  `nicheHint` is an optional default search term to seed the
 *  niche input — useful for presets that imply a category. */
export interface OutlierPreset {
  id: string;
  label: string;
  description: string;
  filters: OutlierFilters;
  nicheHint?: string;
}

/** Nine smart-presets curated for the operator. Order matters —
 *  the UI surfaces them in this sequence as preset chips. */
export const BUILTIN_OUTLIER_PRESETS: readonly OutlierPreset[] = Object.freeze([
  {
    id: 'breakout-shorts',
    label: 'Breakout shorts',
    description: 'Shorts that punched above their channel size — fast to copy, low production cost.',
    filters: { formats: ['short'], minOutlierScore: 3, sortBy: 'outlier' },
  },
  {
    id: 'hidden-gems',
    label: 'Hidden gems',
    description: 'Viral videos from tiny channels — proof a niche works without a big-channel cushion.',
    filters: {
      channelSizes: ['tiny'],
      minOutlierScore: 10,
      publishedWithinDays: 90,
      sortBy: 'outlier',
    },
  },
  {
    id: 'sleeper-hits',
    label: 'Sleeper hits',
    description: 'Mid-size channels (100K–1M) with a recent viral that didn\'t get a press cycle.',
    filters: {
      channelSizes: ['mid'],
      minOutlierScore: 10,
      publishedWithinDays: 30,
      sortBy: 'newest',
    },
  },
  {
    id: 'new-voice-rising',
    label: 'New voice rising',
    description: 'Tiny channels with a recent breakout — early signal on the next big creator in the niche.',
    filters: {
      channelSizes: ['tiny'],
      minOutlierScore: 3,
      publishedWithinDays: 30,
      sortBy: 'newest',
    },
  },
  {
    id: 'long-form-winners',
    label: 'Long-form winners',
    description: 'Long-form (≥ 8 min) breakouts. Mid-roll eligible, sponsorship-friendly format.',
    filters: { formats: ['long'], minOutlierScore: 3, sortBy: 'outlier' },
  },
  {
    id: 'recently-viral',
    label: 'Recently viral',
    description: 'Anything viral in the last week — copy fast or skip, the window closes quickly.',
    filters: { minOutlierScore: 10, publishedWithinDays: 7, sortBy: 'newest' },
  },
  {
    id: 'mid-roll-friendly',
    label: 'Mid-roll friendly',
    description: 'Long-form breakouts with ≥ 100K views — the sweet spot for ad revenue at scale.',
    filters: {
      formats: ['long'],
      minOutlierScore: 3,
      minViews: 100_000,
      sortBy: 'views',
    },
  },
  {
    id: 'consistent-winners',
    label: 'Consistent winners',
    description: 'Channels with multiple hits in this niche — the signal that a creator can repeat, not luck out once.',
    filters: { consistentWinnersOnly: true, minOutlierScore: 1, sortBy: 'outlier' },
  },
  {
    id: 'punchy-titles',
    label: 'Punchy-title winners',
    description: 'Outlier videos with short, hook-style titles (≤ 40 chars). Steal the title pattern, not the topic.',
    filters: { titleLengths: ['punchy'], minOutlierScore: 3, sortBy: 'outlier' },
  },
]);

/** Look up a built-in preset by id. */
export function getBuiltinPreset(id: string): OutlierPreset | undefined {
  return BUILTIN_OUTLIER_PRESETS.find((p) => p.id === id);
}
