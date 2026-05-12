/**
 * Shared pure helpers used across scoring dimensions.
 *
 * Anything stateful goes elsewhere — these are deterministic, no I/O,
 * trivial to unit-test, and form the math foundation of the scorer.
 */
import type { ConfidenceLabel } from '../types';

/** Clamp `x` into `[lo, hi]`. NaN → `lo` so a poisoned numerator can't
 *  cascade silently. ±Infinity → the nearest bound (Infinity → `hi`,
 *  -Infinity → `lo`) so divide-by-zero in upstream weight math still
 *  produces a sane output. */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  if (x === Number.POSITIVE_INFINITY) return hi;
  if (x === Number.NEGATIVE_INFINITY) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Mean of an array of finite numbers. Empty arrays return 0
 *  (callers can branch on length when 0 would be misleading). */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const v of xs) {
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Median of an array of finite numbers. Empty arrays return 0. */
export function median(xs: readonly number[]): number {
  const filtered = xs.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const n = filtered.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return filtered[(n - 1) / 2];
  return (filtered[n / 2 - 1] + filtered[n / 2]) / 2;
}

/** Map a positive value through a log-shaped curve to [0,1]. `scale`
 *  is the value that maps to ≈0.5. Useful for view counts and other
 *  long-tail distributions where linear normalisation crushes the
 *  spread. Negative or non-finite inputs return 0. */
export function logNormalize(value: number, scale: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (scale <= 0) return 0;
  const x = Math.log10(1 + value);
  const s = Math.log10(1 + scale);
  return clamp(x / (2 * s), 0, 1);
}

/** Parse YouTube ISO-8601 durations like "PT8M14S" or "PT1H2M3S" into
 *  seconds. Returns 0 for malformed inputs. */
export function parseDurationToSeconds(iso: string): number {
  if (typeof iso !== 'string' || iso.length === 0) return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const seconds = m[3] ? parseInt(m[3], 10) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Bucket a [0,1] numeric into a four-way plain-English label. Same
 *  thresholds for demand, monetization, etc. The supply dimension has
 *  its own labels but the same bucket boundaries — see supply.ts. */
export function bucketToLabel(numeric: number): 0 | 1 | 2 | 3 {
  const x = clamp(numeric, 0, 1);
  if (x < 0.25) return 0;
  if (x < 0.5) return 1;
  if (x < 0.75) return 2;
  return 3;
}

/** Derive a confidence label from the sample size that drove a score.
 *
 *  - n < 5  → 'rough guess' (genuinely thin)
 *  - n < 20 → 'fairly confident' (working sample)
 *  - n ≥ 20 → 'pretty sure' (enough variance to settle)
 *
 *  Why these thresholds: 5 is the minimum the breakout detector
 *  (Phase 9.5) refused below; 20 lines up with the cluster-sample
 *  target of 20-50 videos. */
export function confidenceFromSampleSize(n: number): ConfidenceLabel {
  if (!Number.isFinite(n) || n < 5) return 'rough guess';
  if (n < 20) return 'fairly confident';
  return 'pretty sure';
}

/** Months between two ISO timestamps. Used for "new entrant" checks
 *  and recency windows. Returns 0 for malformed inputs. */
export function monthsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60 * 24 * 30.44);
}
