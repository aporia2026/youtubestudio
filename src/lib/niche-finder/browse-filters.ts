/**
 * Filter + sort + preset machinery for the Browse Categories tab.
 *
 * Pure functions only — every filter and every preset is
 * deterministic. The UI applies these client-side over the already-
 * fetched DiscoveryResultItem[] so dialling filters doesn't re-burn
 * YouTube quota.
 *
 * Filter dimensions (6):
 *   1. demandMin       — DemandLabel floor (medium+ / high+ / very-high).
 *   2. crowdednessMax  — SupplyLabel ceiling (wide-open only / room+ /
 *                        non-saturated). "Non-saturated" excludes only
 *                        the `saturated` bucket.
 *   3. rpmMinChip      — One-click $/1k floor (0/5/10/20).
 *   4. rpmRange        — Precise dual-handle slider over USD/1k. When
 *                        set, supersedes `rpmMinChip` for the floor.
 *   5. fitMin          — FitLabel floor (could-work+ / strong only).
 *   6. sortBy          — sweet-spot (default) / demand / crowdedness /
 *                        rpm / fit / combined.
 *
 * `language` and `region` are NOT client-side filters — they affect
 * which sample is scored upstream, so changing them triggers a refetch
 * in the parent. They live on the parent's state, not in BrowseFilters.
 *
 * The default sort `sweet-spot` is the killer use case: high demand,
 * low competition, decent RPM. Formula in `sweetSpotScore`.
 */
import type {
  DemandLabel,
  FitLabel,
  NicheScores,
  SupplyLabel,
} from './types';
import type { DiscoveryResultItem } from './discoveries-db';

// ---------------------------------------------------------------------------
// Filter buckets + rank helpers
// ---------------------------------------------------------------------------

/** Demand floor chip. `any` = no filter; others are inclusive minimums. */
export type DemandTier = 'any' | 'medium' | 'high' | 'very-high';

/** Crowdedness ceiling chip. `any` = no filter; others are inclusive
 *  maximums where `wide-open` is the strictest (only wide-open survives). */
export type CrowdednessMax = 'any' | 'non-saturated' | 'room' | 'wide-open';

/** Fit floor chip. */
export type FitMin = 'any' | 'could-work' | 'strong';

/** Sort order. `sweet-spot` is the default — see `sweetSpotScore`. */
export type BrowseSortBy =
  | 'sweet-spot'
  | 'demand'
  | 'crowdedness'
  | 'rpm'
  | 'fit'
  | 'combined';

/** Label → 0..N rank. Higher = better for the operator. */
const DEMAND_RANK: Record<DemandLabel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  'very high': 3,
};

/** Label → 0..N rank for SUPPLY. Higher = MORE crowded = WORSE for
 *  the operator (matches `scoring/supply.ts` where numeric ascends
 *  with saturation). Invert in the sweet-spot formula. */
const SUPPLY_CROWDEDNESS_RANK: Record<SupplyLabel, number> = {
  'wide open': 0,
  'room to enter': 1,
  crowded: 2,
  saturated: 3,
};

const FIT_RANK: Record<FitLabel, number> = {
  'not for you': 0,
  'could work': 1,
  'strong fit': 2,
};

/** Inclusive minimum demand rank for a given chip selection. */
function demandFloorRank(tier: DemandTier | undefined): number {
  switch (tier) {
    case 'medium':
      return DEMAND_RANK.medium;
    case 'high':
      return DEMAND_RANK.high;
    case 'very-high':
      return DEMAND_RANK['very high'];
    default:
      return 0;
  }
}

/** Inclusive maximum crowdedness rank for a given chip selection.
 *  Returns +∞ when no filter is active. */
function crowdednessCeilingRank(max: CrowdednessMax | undefined): number {
  switch (max) {
    case 'wide-open':
      return SUPPLY_CROWDEDNESS_RANK['wide open'];
    case 'room':
      return SUPPLY_CROWDEDNESS_RANK['room to enter'];
    case 'non-saturated':
      return SUPPLY_CROWDEDNESS_RANK.crowded;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** Inclusive minimum fit rank for a given chip selection. */
function fitFloorRank(min: FitMin | undefined): number {
  switch (min) {
    case 'could-work':
      return FIT_RANK['could work'];
    case 'strong':
      return FIT_RANK['strong fit'];
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Filter object
// ---------------------------------------------------------------------------

export interface BrowseFilters {
  /** Inclusive demand floor. Undefined = no filter. */
  demandMin?: DemandTier;
  /** Inclusive crowdedness ceiling. Undefined = no filter. */
  crowdednessMax?: CrowdednessMax;
  /** One-click $/1k floor chip (0 / 5 / 10 / 20). Superseded by `rpmRange`. */
  rpmMinChip?: number;
  /** Precise USD/1k range slider. When set with a non-default span,
   *  supersedes `rpmMinChip` for the floor and also applies a ceiling. */
  rpmRange?: readonly [number, number];
  /** Inclusive fit floor. Undefined = no filter. */
  fitMin?: FitMin;
  /** Sort order — default `sweet-spot`. */
  sortBy?: BrowseSortBy;
  /** Tracks which built-in preset is active for badge purposes.
   *  Not used in filter/sort math — purely a UI breadcrumb so the
   *  preset bar can render the active chip. Cleared whenever the user
   *  manually edits a filter. */
  preset?: string | null;
}

/** RPM slider domain ceiling. The full range [0, RPM_RANGE_MAX] reads
 *  as "no filter" and the floor falls back to `rpmMinChip`. */
export const RPM_RANGE_MAX = 50;

/** Returns the range if it actually narrows the dimension, else null.
 *  Mirrors `activeRange` in outlier-filters.ts. */
export function activeRpmRange(
  range: readonly [number, number] | undefined,
): readonly [number, number] | null {
  if (!range) return null;
  const [lo, hi] = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo <= 0 && hi >= RPM_RANGE_MAX) return null;
  return [Math.max(0, lo), Math.min(RPM_RANGE_MAX, hi)];
}

export const DEFAULT_FILTERS: BrowseFilters = Object.freeze({
  sortBy: 'sweet-spot',
  preset: 'sweet-spot',
  demandMin: 'high',
  crowdednessMax: 'non-saturated',
  rpmMinChip: 10,
});

// ---------------------------------------------------------------------------
// Sweet-spot scoring
// ---------------------------------------------------------------------------

/** Normalised 0–1 rank of a demand score by label. */
function demandRank01(scores: NicheScores): number {
  return DEMAND_RANK[scores.demand.label] / 3;
}

/** Normalised 0–1 rank of "openness" — i.e. how UN-crowded a niche is.
 *  Inverted from the SupplyLabel ordering so higher = better. */
function opennessRank01(scores: NicheScores): number {
  return (3 - SUPPLY_CROWDEDNESS_RANK[scores.supply.label]) / 3;
}

/** Normalised 0–1 RPM floor rank. Caps at $30/k so a $50 outlier
 *  doesn't dominate the formula. Uses the LOW end of the monetization
 *  range (the honest floor), not the midpoint. */
function rpmFloorRank01(scores: NicheScores): number {
  const floor = Number.isFinite(scores.monetization.lowUsdPerMille)
    ? scores.monetization.lowUsdPerMille
    : 0;
  return Math.min(1, Math.max(0, floor / 30));
}

function fitRank01(scores: NicheScores): number {
  return FIT_RANK[scores.fit.label] / 2;
}

/** Sweet-spot composite — high demand + low competition + decent RPM.
 *
 *  Weights:
 *    0.40 * demand
 *    0.35 * (1 - crowdedness)
 *    0.20 * rpm floor
 *    0.05 * fit
 *
 *  Tune by editing these constants — they're the only knobs and they
 *  live in one place so a future operator can re-balance the
 *  recommendation without touching the filter or sort code. */
export const SWEET_SPOT_WEIGHTS = Object.freeze({
  demand: 0.4,
  openness: 0.35,
  rpm: 0.2,
  fit: 0.05,
});

export function sweetSpotScore(scores: NicheScores): number {
  return (
    SWEET_SPOT_WEIGHTS.demand * demandRank01(scores) +
    SWEET_SPOT_WEIGHTS.openness * opennessRank01(scores) +
    SWEET_SPOT_WEIGHTS.rpm * rpmFloorRank01(scores) +
    SWEET_SPOT_WEIGHTS.fit * fitRank01(scores)
  );
}

/** True when an item passes the BUILTIN "sweet-spot" preset's
 *  thresholds. Used by DiscoveryCard to render a small green badge so
 *  the operator can spot the recommended niches at a glance. */
export function isSweetSpot(scores: NicheScores): boolean {
  return (
    DEMAND_RANK[scores.demand.label] >= DEMAND_RANK.high &&
    SUPPLY_CROWDEDNESS_RANK[scores.supply.label] <= SUPPLY_CROWDEDNESS_RANK['room to enter'] &&
    scores.monetization.lowUsdPerMille >= 10
  );
}

// ---------------------------------------------------------------------------
// Core filter + sort
// ---------------------------------------------------------------------------

/** Apply filters + sort. Pure — returns a new array, never mutates. */
export function filterAndSortDiscoveries(
  items: readonly DiscoveryResultItem[],
  filters: BrowseFilters,
): DiscoveryResultItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const rpmRange = activeRpmRange(filters.rpmRange);
  const demandFloor = demandFloorRank(filters.demandMin);
  const crowdedCeiling = crowdednessCeilingRank(filters.crowdednessMax);
  const fitFloor = fitFloorRank(filters.fitMin);
  // RPM floor: range supersedes chip when active.
  const rpmFloor = rpmRange
    ? rpmRange[0]
    : Number.isFinite(filters.rpmMinChip) && (filters.rpmMinChip ?? 0) > 0
      ? filters.rpmMinChip!
      : 0;
  const rpmCeiling = rpmRange ? rpmRange[1] : Number.POSITIVE_INFINITY;

  const filtered = items.filter((item) => {
    const s: NicheScores = item.scores;
    if (DEMAND_RANK[s.demand.label] < demandFloor) return false;
    if (SUPPLY_CROWDEDNESS_RANK[s.supply.label] > crowdedCeiling) return false;
    if (FIT_RANK[s.fit.label] < fitFloor) return false;
    // RPM check uses HIGH end against the floor so a niche with range
    // $8–$15 still passes a $10 floor (its top end clears it). And the
    // LOW end against the ceiling, so a $30+ niche is excluded when
    // the user has capped at $20. This is the most generous reading of
    // an uncertain range — see monetization.ts on why the band is
    // always a range, not a point.
    if (s.monetization.highUsdPerMille < rpmFloor) return false;
    if (s.monetization.lowUsdPerMille > rpmCeiling) return false;
    return true;
  });

  return sortDiscoveries(filtered, filters.sortBy ?? 'sweet-spot');
}

function sortDiscoveries(
  items: readonly DiscoveryResultItem[],
  sortBy: BrowseSortBy,
): DiscoveryResultItem[] {
  const arr = items.slice();
  switch (sortBy) {
    case 'demand':
      arr.sort((a, b) => b.scores.demand.numeric - a.scores.demand.numeric);
      break;
    case 'crowdedness':
      // Ascending: least crowded first.
      arr.sort((a, b) => a.scores.supply.numeric - b.scores.supply.numeric);
      break;
    case 'rpm':
      // By floor descending — the honest measure of "this monetizes well".
      arr.sort(
        (a, b) => b.scores.monetization.lowUsdPerMille - a.scores.monetization.lowUsdPerMille,
      );
      break;
    case 'fit':
      arr.sort((a, b) => b.scores.fit.numeric - a.scores.fit.numeric);
      break;
    case 'combined':
      arr.sort((a, b) => b.scores.combined - a.scores.combined);
      break;
    case 'sweet-spot':
    default:
      arr.sort((a, b) => sweetSpotScore(b.scores) - sweetSpotScore(a.scores));
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

export interface BrowsePreset {
  id: string;
  label: string;
  description: string;
  filters: BrowseFilters;
}

/** Five one-click presets curated for the operator. Order matters —
 *  the UI surfaces them in this sequence as preset chips. The first
 *  ("sweet-spot") is the default applied on first load and matches
 *  DEFAULT_FILTERS exactly. */
export const BUILTIN_BROWSE_PRESETS: readonly BrowsePreset[] = Object.freeze([
  {
    id: 'sweet-spot',
    label: 'Sweet spot',
    description:
      'High demand, room to enter, and at least $10 per 1k views. The classic "great potential + low competition + worth your time" combo.',
    filters: {
      sortBy: 'sweet-spot',
      preset: 'sweet-spot',
      demandMin: 'high',
      crowdednessMax: 'non-saturated',
      rpmMinChip: 10,
    },
  },
  {
    id: 'untapped-gems',
    label: 'Untapped gems',
    description:
      'Wide-open niches with at least medium demand. Less proven RPM but a clearer runway for a new channel.',
    filters: {
      sortBy: 'crowdedness',
      preset: 'untapped-gems',
      demandMin: 'medium',
      crowdednessMax: 'wide-open',
    },
  },
  {
    id: 'premium-rpm',
    label: 'Premium RPM',
    description:
      'Filter on monetization alone: niches with a floor of $20+ per 1k views, regardless of competition. Great when you can already write quality content for the audience.',
    filters: {
      sortBy: 'rpm',
      preset: 'premium-rpm',
      rpmMinChip: 20,
    },
  },
  {
    id: 'beginner-friendly',
    label: 'Beginner-friendly',
    description:
      'Wide-open niches with at least $5 per 1k views. Designed for a first channel — you trade RPM ceiling for a real chance of being seen.',
    filters: {
      sortBy: 'crowdedness',
      preset: 'beginner-friendly',
      crowdednessMax: 'wide-open',
      rpmMinChip: 5,
    },
  },
  {
    id: 'my-fit',
    label: 'My fit',
    description:
      'Only niches the system thinks are a strong fit for your declared interests, sorted by sweet-spot score.',
    filters: {
      sortBy: 'sweet-spot',
      preset: 'my-fit',
      fitMin: 'strong',
    },
  },
]);

/** Look up a built-in preset by id. */
export function getBuiltinBrowsePreset(id: string): BrowsePreset | undefined {
  return BUILTIN_BROWSE_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Quadrant-view helpers
// ---------------------------------------------------------------------------

/** RPM tier for chart bubble colour. Three bands match the three
 *  bullet chips in the filter bar — visually grouped with the filter
 *  UI so the colour code reads instantly. */
export type RpmTier = 'low' | 'mid' | 'high';

export function rpmTier(scores: NicheScores): RpmTier {
  const floor = scores.monetization.lowUsdPerMille;
  if (floor >= 20) return 'high';
  if (floor >= 10) return 'mid';
  return 'low';
}

/** 0..1 x-coordinate for the quadrant view (demand). */
export function quadrantX(scores: NicheScores): number {
  return demandRank01(scores);
}

/** 0..1 y-coordinate for the quadrant view (openness — inverted
 *  crowdedness so the "sweet spot" is the top-right quadrant). */
export function quadrantY(scores: NicheScores): number {
  return opennessRank01(scores);
}

/** 0..1 fit rank for bubble radius. */
export function quadrantFit(scores: NicheScores): number {
  return fitRank01(scores);
}
