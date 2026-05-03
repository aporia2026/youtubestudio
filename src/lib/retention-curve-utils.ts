/**
 * Pure curve utilities shared between the retention predictor and the
 * prediction-outcomes lib.
 *
 * Lives here (not in retention-predictor.ts) because Phase 8.6.2 needed
 * to break a circular import: retention-predictor.ts imports
 * findFewShotOutcomes from prediction-outcomes.ts, which in turn needs
 * normalizeCurve to coerce stored JSONB curves. With both files
 * importing normalizeCurve from a third module, neither depends on the
 * other and the cycle disappears.
 *
 * No DB or network deps — fully unit-testable.
 */
import type { RetentionPoint } from './retention-predictor-types';

/**
 * Coerce arbitrary JSON into a RetentionPoint[] with bounded values.
 * Drops any entry that doesn't have finite numeric position + retention.
 * Sorts ascending by position so the curve is monotonic-x even when
 * the input arrived shuffled.
 */
export function normalizeCurve(raw: unknown): RetentionPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: RetentionPoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const p = typeof e.position === 'number' ? e.position : null;
    const r = typeof e.retention === 'number' ? e.retention : null;
    if (p === null || r === null || !Number.isFinite(p) || !Number.isFinite(r)) continue;
    out.push({
      position: Math.max(0, Math.min(1, p)),
      retention: Math.max(0, Math.min(1, r)),
    });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}
