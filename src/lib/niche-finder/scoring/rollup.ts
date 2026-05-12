/**
 * Cluster-to-niche rollup + combined sort score.
 *
 * A niche owns 3-8 concept clusters. Each cluster has been scored
 * across the four dimensions. The rollup:
 *
 *   1. Averages each dimension across the clusters (weighted by the
 *      cluster's sample size — more videos = more vote).
 *   2. Picks the *worst* confidence label across the clusters for
 *      each dimension (the niche is only as confident as its
 *      thinnest sample).
 *   3. Computes a combined sort score where supply is inverted
 *      (high supply = bad), giving:
 *         combined = 0.3·demand + 0.3·(1 - supply)
 *                  + 0.3·monetization + 0.1·fit
 *
 * Monetization roll-up needs special handling because of the
 * per-1,000-views range: we take the sample-weighted mean of the
 * low and high bounds independently.
 */
import type {
  ConfidenceLabel,
  DemandScore,
  FitScore,
  MonetizationScore,
  NicheScores,
  SupplyScore,
} from '../types';
import { clamp } from './shared';

/** Per-cluster bundle of scores plus the sample size that produced
 *  them. Sample size weights the rollup mean. */
export interface ClusterScores {
  sampleSize: number;
  demand: DemandScore;
  supply: SupplyScore;
  monetization: MonetizationScore;
  fit: FitScore;
}

/** Order confidence labels from weakest to strongest so we can pick
 *  the minimum across clusters. */
const CONFIDENCE_RANK: Record<ConfidenceLabel, number> = {
  'rough guess': 0,
  'fairly confident': 1,
  'pretty sure': 2,
};

function minConfidence(labels: readonly ConfidenceLabel[]): ConfidenceLabel {
  if (labels.length === 0) return 'rough guess';
  let lowest: ConfidenceLabel = labels[0];
  for (const c of labels) {
    if (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[lowest]) lowest = c;
  }
  return lowest;
}

/** Sample-size-weighted mean. Falls back to a simple mean when all
 *  weights are zero. */
function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = weights[i];
    if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) continue;
    num += v * w;
    den += w;
  }
  if (den === 0) {
    if (values.length === 0) return 0;
    return values.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0) / values.length;
  }
  return num / den;
}

/** Roll cluster-level scores up to a niche-level score bundle. */
export function rollupClusterScores(clusters: readonly ClusterScores[]): NicheScores {
  if (clusters.length === 0) {
    throw new Error('rollupClusterScores: at least one cluster required');
  }

  const weights = clusters.map((c) => Math.max(1, c.sampleSize));

  const demandNumeric = clamp(
    weightedMean(clusters.map((c) => c.demand.numeric), weights),
    0,
    1,
  );
  const supplyNumeric = clamp(
    weightedMean(clusters.map((c) => c.supply.numeric), weights),
    0,
    1,
  );
  const monetizationNumeric = clamp(
    weightedMean(clusters.map((c) => c.monetization.numeric), weights),
    0,
    1,
  );
  const fitNumeric = clamp(
    weightedMean(clusters.map((c) => c.fit.numeric), weights),
    0,
    1,
  );

  const monetizationLow = weightedMean(
    clusters.map((c) => c.monetization.lowUsdPerMille),
    weights,
  );
  const monetizationHigh = weightedMean(
    clusters.map((c) => c.monetization.highUsdPerMille),
    weights,
  );

  // Pick the most representative label from the highest-weighted
  // cluster — averaging labels doesn't make sense, but the cluster
  // with the largest sample is the most defensible single source.
  const dominant = clusters.reduce((best, c) =>
    c.sampleSize > best.sampleSize ? c : best,
  );

  const combined = clamp(
    0.3 * demandNumeric +
      0.3 * (1 - supplyNumeric) +
      0.3 * monetizationNumeric +
      0.1 * fitNumeric,
    0,
    1,
  );

  return {
    demand: {
      ...dominant.demand,
      numeric: demandNumeric,
      confidence: minConfidence(clusters.map((c) => c.demand.confidence)),
    },
    supply: {
      ...dominant.supply,
      numeric: supplyNumeric,
      confidence: minConfidence(clusters.map((c) => c.supply.confidence)),
    },
    monetization: {
      ...dominant.monetization,
      numeric: monetizationNumeric,
      lowUsdPerMille: Number(monetizationLow.toFixed(2)),
      highUsdPerMille: Number(monetizationHigh.toFixed(2)),
      confidence: minConfidence(clusters.map((c) => c.monetization.confidence)),
    },
    fit: {
      ...dominant.fit,
      numeric: fitNumeric,
      confidence: minConfidence(clusters.map((c) => c.fit.confidence)),
    },
    combined,
  };
}
