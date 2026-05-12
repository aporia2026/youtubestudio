/**
 * Niche-finder type system.
 *
 * The user-facing unit is a `Niche`; the engine reasons over
 * `ConceptCluster`s under the hood. Niches are emergent rollups of
 * 3-8 concept clusters that share an audience and an advertiser pool.
 *
 * Council reframe (2026-05-12): scoring at the cluster level produces
 * honest monetization signals because we can sample 20-50 real videos
 * per cluster and observe ad-load class, sponsor density, and view-
 * velocity decay directly — instead of multiplying scraped RPM tables
 * by regex hits like a vidIQ knock-off would.
 *
 * Plain-English score labels are deliberate (per the Outsider council
 * pass): users don't read "DEMAND: 72/100 ± 14" the way they read
 * "How many people want this: high · pretty sure."
 */

// ---------------------------------------------------------------------------
// Plain-English label unions
// ---------------------------------------------------------------------------

/** Demand bucket. "How many people want this." */
export type DemandLabel = 'low' | 'medium' | 'high' | 'very high';

/** Supply / competition bucket. "How crowded it is." */
export type SupplyLabel = 'wide open' | 'room to enter' | 'crowded' | 'saturated';

/** Monetization bucket. "How much money it makes." Not surfaced
 *  directly to the user — we always show the per-1,000-views range
 *  instead — but kept for sorting + cross-niche comparison. */
export type MonetizationLabel = 'low' | 'medium' | 'high' | 'very high';

/** Fit bucket. "How well it fits you." */
export type FitLabel = 'not for you' | 'could work' | 'strong fit';

/** Confidence pill shown next to every score. Plain English; matches
 *  the council's "rough guess vs pretty sure" guidance. */
export type ConfidenceLabel = 'rough guess' | 'fairly confident' | 'pretty sure';

// ---------------------------------------------------------------------------
// Score primitives
// ---------------------------------------------------------------------------

/** A single score dimension. `numeric` is 0-1 (not 0-100) — keeps the
 *  rollup math sane. `label` and `confidence` are the user-facing
 *  forms. `evidence` carries the inputs that drove the score so the
 *  UI can render the math on hover (per the lazy-user walkthrough). */
export interface DimensionScore<TLabel extends string> {
  numeric: number;
  label: TLabel;
  confidence: ConfidenceLabel;
  evidence: Record<string, number | string | null>;
}

export type DemandScore = DimensionScore<DemandLabel>;
export type SupplyScore = DimensionScore<SupplyLabel>;
export type FitScore = DimensionScore<FitLabel>;

/** Monetization carries a per-1,000-views range instead of a single
 *  point estimate, because point estimates without per-channel revenue
 *  data are theatre. The range is always non-empty (lowUsd ≤ highUsd)
 *  and is what the UI actually displays. */
export interface MonetizationScore extends DimensionScore<MonetizationLabel> {
  /** Lower bound of the per-1,000-views revenue estimate, in USD. */
  lowUsdPerMille: number;
  /** Upper bound of the per-1,000-views revenue estimate, in USD. */
  highUsdPerMille: number;
}

/** Bundle of all four dimension scores plus a combined sort score.
 *  `combined` is a weighted sum used only for ranking; the four
 *  dimensions are what we show. */
export interface NicheScores {
  demand: DemandScore;
  supply: SupplyScore;
  monetization: MonetizationScore;
  fit: FitScore;
  combined: number;
}

// ---------------------------------------------------------------------------
// Video + channel inputs the scorer consumes
// ---------------------------------------------------------------------------

/** Minimal video shape the scorer needs. Mirrors what
 *  `fetchYouTubeVideoData` returns from `src/lib/youtube.ts` plus
 *  `channelId`. Anything beyond these fields is irrelevant to
 *  scoring and should not be added here — keeping this narrow makes
 *  the scorer trivial to fixture for tests. */
export interface SampledVideo {
  id: string;
  channelId: string;
  title: string;
  description: string;
  /** Total views to date. */
  viewCount: number;
  /** ISO 8601 publish timestamp. */
  publishedAt: string;
  /** ISO 8601 duration (e.g. "PT8M14S"). The scorer parses this for
   *  mid-roll eligibility (≥8 minutes is YouTube's mid-roll floor). */
  durationIso: string;
  tags: string[];
}

/** Minimal channel shape the scorer needs. */
export interface SampledChannel {
  id: string;
  subscriberCount: number;
  videoCount: number;
  /** ISO 8601 channel-created timestamp; absence is allowed and
   *  drops the "new entrant" signal from supply scoring. */
  createdAt: string | null;
}

/** The full sample for one concept cluster: every video pulled, every
 *  unique channel that authored those videos. The scorer is pure: it
 *  takes this in and returns scores out, no I/O. */
export interface ClusterSample {
  /** Centroid keyword used to fetch the videos. */
  centroidTerm: string;
  videos: readonly SampledVideo[];
  channels: readonly SampledChannel[];
}

// ---------------------------------------------------------------------------
// Concept cluster + niche
// ---------------------------------------------------------------------------

/** A concept cluster — the engine primitive. Defined by a centroid
 *  keyword and a set of related search terms. */
export interface ConceptCluster {
  centroidTerm: string;
  relatedTerms: readonly string[];
  /** Optional pre-fetched sample. The scorer requires this be set
   *  before scoring; route handlers populate it before calling. */
  sample?: ClusterSample;
}

/** A niche — the user-facing rollup of clusters. */
export interface Niche {
  slug: string;
  name: string;
  clusters: readonly ConceptCluster[];
}

/** Operator preferences fed into the fit dimension. Free-text-ish
 *  but normalised at the route boundary to keep the scorer pure. */
export interface OperatorFit {
  interests: readonly string[];
  language: string;
  region: string;
  /** AI-emitted fit score in [0,1]. Provided externally because the
   *  fit dimension is the one place we delegate to an LLM. */
  llmFitScore: number;
  /** AI's one-line rationale. Carried through to the UI on hover. */
  llmRationale: string;
}

// ---------------------------------------------------------------------------
// RPM prior input
// ---------------------------------------------------------------------------

/** A row in the static category RPM prior table. The monetization
 *  dimension uses this only as a soft prior — the floor and the
 *  point estimate come from the per-cluster observed sample. */
export interface RpmPriorRow {
  /** Stable slug matching `RPM_CATEGORY_KEYWORDS` keys. */
  category: string;
  /** Lower-bound USD per 1,000 views for the category. */
  lowUsdPerMille: number;
  /** Upper-bound USD per 1,000 views for the category. */
  highUsdPerMille: number;
  /** Source citation for the row — recorded so we can refresh later. */
  source: string;
  /** ISO date of when the row was last verified. Stale-warns at 12
   *  months past this date. */
  asOf: string;
}
