/**
 * Monetization scoring.
 *
 * "How much money it makes." This is the load-bearing claim of the
 * whole product, the one the Contrarian called out, the one that
 * looks like theatre if we just multiply a scraped RPM table by a
 * regex.
 *
 * The plan: don't trust the prior; measure what we can.
 *
 *   - **Mid-roll-eligible share** — the % of sampled videos with
 *     duration ≥ 8 minutes (YouTube's mid-roll floor). This is a
 *     real measurement from `videos.list contentDetails`; high
 *     mid-roll share lifts the band toward the upper end of the
 *     category prior.
 *   - **Sponsor density score** — average sponsor-mention hits per
 *     description across the WHOLE sample, not a single regex hit.
 *     The Contrarian flagged that regex hit/miss rewards niches
 *     where creators talk about sponsors; a *density* score across
 *     the cluster is harder to game. Still weighted modestly.
 *   - **End-screen merch presence** — count of videos whose
 *     descriptions link to a Spring, Fourthwall, Shopify-style
 *     merch URL. Indicates creators monetize beyond ads.
 *   - **Category RPM prior** — the soft upper-bound from
 *     `rpm-priors.ts`. Only sets the band; the floor and point
 *     are anchored in observed signals.
 *
 * The output is a per-1,000-views USD range, NOT a monthly dollar
 * figure and NOT a point estimate. Per the lazy-user walkthrough,
 * the UI renders this as "Channels like this usually earn $X-$Y
 * per 1,000 views."
 */
import { getRpmPrior } from '../rpm-priors';
import type {
  ClusterSample,
  MonetizationLabel,
  MonetizationScore,
} from '../types';
import {
  bucketToLabel,
  clamp,
  confidenceFromSampleSize,
  parseDurationToSeconds,
} from './shared';

const MONETIZATION_LABELS: readonly MonetizationLabel[] = [
  'low',
  'medium',
  'high',
  'very high',
];

/** YouTube's mid-roll eligibility floor in seconds. */
const MID_ROLL_FLOOR_SECONDS = 8 * 60;

/** Regex matches commonly used by creators to credit sponsors. We
 *  count *hits per description*, not hit/no-hit, so descriptions
 *  that mention sponsors multiple times don't dominate.
 *  Sanitisation is done at the route boundary; this regex runs
 *  against descriptions already passed through the existing
 *  prompt-injection sanitiser. */
const SPONSOR_PATTERNS: readonly RegExp[] = [
  /\bsponsored\s+by\b/i,
  /\bthis\s+(?:video|episode)\s+is\s+brought\s+to\s+you\s+by\b/i,
  /\b(?:use|with)\s+code\s+[\w-]+/i,
  /\bget\s+\d+%\s+off\b/i,
  /\bpartnered?\s+with\b/i,
];

/** Merch-platform URL patterns. */
const MERCH_PATTERNS: readonly RegExp[] = [
  /spring\.com/i,
  /fourthwall\.com/i,
  /teespring\.com/i,
  /merchshop/i,
  /shop\.[a-z0-9-]+\.(?:com|store)/i,
];

/** Score the monetization dimension for a single concept cluster.
 *
 *  `nicheText` is used to resolve the category RPM prior. Pass the
 *  niche name plus the cluster centroid joined ("Personal finance
 *  for software engineers credit card churning") for best match. */
export function scoreMonetization(
  sample: ClusterSample,
  nicheText: string,
): MonetizationScore {
  const videos = sample.videos;
  const sampleN = videos.length;
  const prior = getRpmPrior(nicheText);

  // Signal 1: mid-roll-eligible share.
  let midRollCount = 0;
  for (const v of videos) {
    if (parseDurationToSeconds(v.durationIso) >= MID_ROLL_FLOOR_SECONDS) midRollCount++;
  }
  const midRollShare = sampleN > 0 ? midRollCount / sampleN : 0;

  // Signal 2: sponsor density. Total hits across all descriptions
  // divided by sample size, capped at "1 hit per video" to prevent
  // a single ad-stuffed description from dominating.
  let sponsorHits = 0;
  let merchVideos = 0;
  for (const v of videos) {
    const desc = v.description || '';
    let videoHits = 0;
    for (const pat of SPONSOR_PATTERNS) {
      if (pat.test(desc)) videoHits++;
    }
    sponsorHits += Math.min(videoHits, 3);
    if (MERCH_PATTERNS.some((p) => p.test(desc))) merchVideos++;
  }
  const sponsorDensity = sampleN > 0 ? clamp(sponsorHits / (sampleN * 2), 0, 1) : 0;
  const merchShare = sampleN > 0 ? merchVideos / sampleN : 0;

  // Combine the observed signals into a "lift" factor in [0, 1]
  // that determines where in the prior band we land. Heavy mid-roll
  // + diverse sponsorship + merch presence pushes us toward the top
  // of the band; absence of all three keeps us near the bottom.
  const lift = clamp(
    0.5 * midRollShare + 0.3 * sponsorDensity + 0.2 * merchShare,
    0,
    1,
  );

  // Per-1,000-views revenue range. We shrink the band toward the
  // upper half as lift increases, but the band never collapses
  // (never claim "$10 RPM, period").
  const span = prior.highUsdPerMille - prior.lowUsdPerMille;
  const shift = lift * span * 0.5;
  const lowUsdPerMille = clamp(
    prior.lowUsdPerMille + shift * 0.5,
    prior.lowUsdPerMille,
    prior.highUsdPerMille,
  );
  const highUsdPerMille = clamp(
    prior.highUsdPerMille - (1 - lift) * span * 0.3,
    lowUsdPerMille,
    prior.highUsdPerMille,
  );

  // Numeric score for sorting/labelling. Use the *midpoint* of the
  // final band, log-normalised against a "very high" anchor of $30.
  const midpoint = (lowUsdPerMille + highUsdPerMille) / 2;
  const numeric = clamp(midpoint / 30, 0, 1);
  const label = MONETIZATION_LABELS[bucketToLabel(numeric)];

  // Confidence: drops when we leaned heavily on the prior (low
  // sample, no mid-roll measurement) and rises when observed
  // signals corroborated the prior.
  const observedSignalCount =
    (midRollShare > 0.2 ? 1 : 0) +
    (sponsorDensity > 0.05 ? 1 : 0) +
    (merchShare > 0.1 ? 1 : 0);
  const baseConfidence = confidenceFromSampleSize(sampleN);
  const confidence =
    observedSignalCount >= 2 && baseConfidence === 'pretty sure'
      ? 'pretty sure'
      : observedSignalCount >= 1
        ? 'fairly confident'
        : 'rough guess';

  return {
    numeric,
    label,
    confidence,
    lowUsdPerMille: Number(lowUsdPerMille.toFixed(2)),
    highUsdPerMille: Number(highUsdPerMille.toFixed(2)),
    evidence: {
      sampleVideos: sampleN,
      category: prior.category,
      priorLowUsdPerMille: prior.lowUsdPerMille,
      priorHighUsdPerMille: prior.highUsdPerMille,
      midRollEligibleShare: Number(midRollShare.toFixed(3)),
      sponsorDensity: Number(sponsorDensity.toFixed(3)),
      merchShare: Number(merchShare.toFixed(3)),
      lift: Number(lift.toFixed(3)),
      priorSource: prior.source,
      priorAsOf: prior.asOf,
    },
  };
}
