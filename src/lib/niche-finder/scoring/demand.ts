/**
 * Demand scoring.
 *
 * "How many people want this." We can't see YouTube's hidden search
 * volume, so demand is a proxy from three observable signals on the
 * sampled videos in the cluster:
 *
 *   - **Total recent views** — the absolute size of the audience that
 *     actually watched the cluster's top videos. Log-normalised so a
 *     50M-view juggernaut doesn't crush the spread between mid-tier
 *     niches.
 *   - **Recent-publish rate** — how many cluster videos were
 *     published in the last 90 days. A niche that hasn't been
 *     publishing in months is dying; one with a steady cadence is
 *     alive.
 *   - **Term diversity** — the count of related YouTube Suggest
 *     terms we harvested for the cluster centroid. More distinct
 *     queries = broader demand surface. This is the weakest signal
 *     (autocomplete heads are saturated) and is weighted low.
 *
 * The output is honest about being a proxy: we surface the
 * underlying numbers in `evidence` so the UI can show the math on
 * hover and label the tooltip "we can see videos and rough views;
 * we can't see what YouTube hides."
 */
import type { ClusterSample, DemandLabel, DemandScore } from '../types';
import {
  bucketToLabel,
  clamp,
  confidenceFromSampleSize,
  logNormalize,
  monthsBetween,
} from './shared';

const DEMAND_LABELS: readonly DemandLabel[] = ['low', 'medium', 'high', 'very high'];

/** Scale factor for view-count log-normalisation. 10M views over the
 *  sample maps to ≈0.5 demand contribution; tuned against documented
 *  small-creator (1M total) vs mid-tier (50M+) gaps. */
const VIEW_COUNT_SCALE = 10_000_000;

/** Scale factor for term-diversity. 30 related terms ≈ a healthy
 *  cluster; we stop growing the diversity bonus past 60. */
const TERM_DIVERSITY_SCALE = 30;

/** Score the demand dimension for a single concept cluster.
 *
 *  `nowIso` is injected so tests are deterministic; defaults to
 *  the current time in production. */
export function scoreDemand(
  sample: ClusterSample,
  relatedTermsCount: number,
  nowIso = new Date().toISOString(),
): DemandScore {
  const videos = sample.videos;
  const n = videos.length;

  // Signal 1: total recent views (log-scaled).
  const totalViews = videos.reduce(
    (sum, v) => sum + (Number.isFinite(v.viewCount) ? v.viewCount : 0),
    0,
  );
  const viewSignal = logNormalize(totalViews, VIEW_COUNT_SCALE);

  // Signal 2: recent-publish rate. Count videos published in the
  // last 12 months and divide by 12 to get monthly cadence; then
  // map "12 videos/month" to 1.0 (a niche with daily uploads is
  // overheated, not extra-demanded).
  const recentVideos = videos.filter((v) => monthsBetween(v.publishedAt, nowIso) <= 12).length;
  const monthlyRate = recentVideos / 12;
  const cadenceSignal = clamp(monthlyRate / 12, 0, 1);

  // Signal 3: term diversity. Capped — a hundred near-synonym
  // autocomplete terms doesn't mean a hundred times the demand.
  const diversitySignal = clamp(relatedTermsCount / (2 * TERM_DIVERSITY_SCALE), 0, 1);

  // Weighted sum. Views dominate; cadence is a tie-breaker;
  // diversity is a weak corroborator.
  const numeric = clamp(
    0.6 * viewSignal + 0.3 * cadenceSignal + 0.1 * diversitySignal,
    0,
    1,
  );

  const label = DEMAND_LABELS[bucketToLabel(numeric)];

  return {
    numeric,
    label,
    confidence: confidenceFromSampleSize(n),
    evidence: {
      sampleVideos: n,
      totalRecentViews: totalViews,
      videosLast12Months: recentVideos,
      relatedTerms: relatedTermsCount,
      // Sub-signals exposed so the UI tooltip can render the math.
      viewSignal: Number(viewSignal.toFixed(3)),
      cadenceSignal: Number(cadenceSignal.toFixed(3)),
      diversitySignal: Number(diversitySignal.toFixed(3)),
    },
  };
}
