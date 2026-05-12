/**
 * Fit scoring.
 *
 * "How well it fits you." This is the one dimension where we delegate
 * the inference to an LLM rather than measuring observable signals,
 * because "fit" is subjective by definition — it's the operator's
 * stated interests vs the niche's actual content.
 *
 * The route handler runs a single AI call (workspace-scoped model
 * resolver, prompt-cached) that returns a [0,1] score plus a one-line
 * rationale; this helper just labels the score and carries the
 * rationale through to the evidence map for the UI tooltip.
 *
 * Keeping this layer pure (no LLM call inside the scoring function)
 * means the kill-criterion test can feed deterministic fit scores
 * and the math is unit-testable.
 */
import type { FitLabel, FitScore, OperatorFit } from '../types';
import { clamp, confidenceFromSampleSize } from './shared';

/** Map a [0,1] fit numeric into a three-way plain-English label.
 *
 *  Fit is three-way, not four-way, because "very high fit" and "high
 *  fit" don't tell the operator anything distinguishable. The
 *  thresholds bias toward "could work" so a marginal AI call doesn't
 *  fail-closed on niches that might actually be worth exploring. */
function labelFit(numeric: number): FitLabel {
  const x = clamp(numeric, 0, 1);
  if (x < 0.35) return 'not for you';
  if (x < 0.7) return 'could work';
  return 'strong fit';
}

/** Score the fit dimension from the LLM's emitted fit score plus the
 *  operator's stated interests. `sampleSize` is the number of cluster
 *  videos the LLM saw — used to set confidence the same way the other
 *  dimensions do. */
export function scoreFit(fit: OperatorFit, sampleSize: number): FitScore {
  const numeric = clamp(fit.llmFitScore, 0, 1);
  const label = labelFit(numeric);
  return {
    numeric,
    label,
    confidence: confidenceFromSampleSize(sampleSize),
    evidence: {
      llmFitScore: Number(numeric.toFixed(3)),
      llmRationale: fit.llmRationale || '',
      interests: fit.interests.join(', '),
      language: fit.language,
      region: fit.region,
    },
  };
}
