/**
 * Supply / competition scoring.
 *
 * "How crowded it is." Higher numeric = MORE saturated = WORSE for a
 * new entrant. The rollup inverts this when computing the combined
 * sort score.
 *
 * Four observable signals:
 *
 *   - **Channel concentration** — what share of the cluster's total
 *     views in the sample is held by the top 3 channels. A cluster
 *     where 3 channels own 80% of views is harder to break into than
 *     one where 50 channels share evenly.
 *   - **Median channel age** — older top channels mean entrenched
 *     incumbents with long tail catalogs that auto-play first.
 *   - **New-entrant rate** — what share of the top channels were
 *     created within the last 18 months. High = the niche is
 *     letting newcomers through; low = entrenched.
 *   - **Channel count** — how many distinct channels show up in the
 *     sample. A larger pool is mildly crowdier all else equal.
 */
import type { ClusterSample, SupplyLabel, SupplyScore } from '../types';
import {
  bucketToLabel,
  clamp,
  confidenceFromSampleSize,
  median,
  monthsBetween,
} from './shared';

const SUPPLY_LABELS: readonly SupplyLabel[] = [
  'wide open',
  'room to enter',
  'crowded',
  'saturated',
];

/** Cap on the channel-count signal. A cluster with 50+ distinct
 *  channels in its top videos has saturated supply regardless of
 *  the other signals. */
const CHANNEL_COUNT_CAP = 50;

/** Months past which a channel stops counting as a "new entrant".
 *  18 months is a reasonable proxy for "started in the last YT
 *  algorithm cycle." */
const NEW_ENTRANT_MONTHS = 18;

/** Score the supply dimension for a single concept cluster. */
export function scoreSupply(
  sample: ClusterSample,
  nowIso = new Date().toISOString(),
): SupplyScore {
  const videos = sample.videos;
  const channels = sample.channels;
  const sampleN = videos.length;

  // Signal 1: top-channel concentration. Sum views per channel from
  // the sample, sort, take the share held by the top 3.
  const viewsByChannel = new Map<string, number>();
  let totalViews = 0;
  for (const v of videos) {
    const views = Number.isFinite(v.viewCount) ? v.viewCount : 0;
    viewsByChannel.set(v.channelId, (viewsByChannel.get(v.channelId) ?? 0) + views);
    totalViews += views;
  }
  const sorted = Array.from(viewsByChannel.values()).sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((s, n) => s + n, 0);
  const concentrationSignal = totalViews > 0 ? clamp(top3 / totalViews, 0, 1) : 0;

  // Signal 2: median channel age in months. Older = more saturated.
  // A 36-month median maps to ≈0.6; 60+ months saturates at 1.0.
  const ageMonths = channels
    .map((c) => (c.createdAt ? monthsBetween(c.createdAt, nowIso) : null))
    .filter((m): m is number => m !== null && m > 0);
  const medianAgeMonths = median(ageMonths);
  const ageSignal = clamp(medianAgeMonths / 60, 0, 1);

  // Signal 3: new-entrant rate. Channels younger than the threshold
  // / total channels with known ages. Inverted — high new-entrant
  // rate REDUCES saturation.
  const channelsWithAge = ageMonths.length;
  const newEntrants = ageMonths.filter((m) => m <= NEW_ENTRANT_MONTHS).length;
  const newEntrantRate = channelsWithAge > 0 ? newEntrants / channelsWithAge : 0;
  const newEntrantSignal = 1 - newEntrantRate;

  // Signal 4: distinct channel count. Capped.
  const distinctChannels = viewsByChannel.size;
  const countSignal = clamp(distinctChannels / CHANNEL_COUNT_CAP, 0, 1);

  // Weighted sum. Concentration is the strongest signal of "the top
  // is locked"; age + new-entrants together encode "is the door
  // open"; raw channel count is a minor input.
  const numeric = clamp(
    0.4 * concentrationSignal +
      0.25 * ageSignal +
      0.25 * newEntrantSignal +
      0.1 * countSignal,
    0,
    1,
  );

  const label = SUPPLY_LABELS[bucketToLabel(numeric)];

  return {
    numeric,
    label,
    confidence: confidenceFromSampleSize(sampleN),
    evidence: {
      sampleVideos: sampleN,
      distinctChannels,
      top3ViewShare: Number(concentrationSignal.toFixed(3)),
      medianChannelAgeMonths: Number(medianAgeMonths.toFixed(1)),
      newEntrantRate: Number(newEntrantRate.toFixed(3)),
      // Sub-signals exposed for the UI tooltip.
      concentrationSignal: Number(concentrationSignal.toFixed(3)),
      ageSignal: Number(ageSignal.toFixed(3)),
      newEntrantSignal: Number(newEntrantSignal.toFixed(3)),
      countSignal: Number(countSignal.toFixed(3)),
    },
  };
}
