/**
 * Niche-finder scoring barrel. Re-exports the pure helpers + the
 * four dimension scorers + the rollup so consumers can import from
 * `@/lib/niche-finder/scoring` without reaching into individual files.
 */
export { scoreDemand } from './demand';
export { scoreSupply } from './supply';
export { scoreMonetization } from './monetization';
export { scoreFit } from './fit';
export { rollupClusterScores, type ClusterScores } from './rollup';
export {
  bucketToLabel,
  clamp,
  confidenceFromSampleSize,
  logNormalize,
  mean,
  median,
  monthsBetween,
  parseDurationToSeconds,
} from './shared';
