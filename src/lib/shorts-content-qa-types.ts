/**
 * Client-safe types for the editor's Shorts content-QA tab.
 *
 * Split from `shorts-content-qa.ts` (which imports server-only modules
 * for the AI grader + Brave fact-checker) so that `shorts-types.ts`
 * can declare `ShortRow.qa_result` without dragging the AI runtime
 * into the client bundle. Mirrors the dubbing-languages /
 * shorts-render-types split.
 *
 * The orchestrator + prompt builder + parser live in
 * `src/lib/shorts-content-qa.ts`. See
 * `_plans/2026-06-07-shorts-script-qa-tab.md` for the rubric design.
 */

/** Stable keys for the 7 shorts-tuned QA dimensions. Listed in display
 *  order. `factual_accuracy` is pinned first because that's the
 *  headline dimension the tab was built for. */
export const SHORTS_QA_DIMENSION_KEYS = [
  'factual_accuracy',
  'hook_strength',
  'content_quality',
  'payoff_clarity',
  'audience_targeting',
  'pacing_density',
  'caption_readability',
] as const;

export type ShortsQaDimensionKey = (typeof SHORTS_QA_DIMENSION_KEYS)[number];

/** Per-dimension score returned by the AI grader. All scores are 0–100
 *  ints to match the long-form QA convention (composite is a weighted
 *  average that's also rounded to an int). */
export interface ShortsQaDimensionScore {
  score: number;
  /** One-paragraph assessment in plain English. */
  assessment: string;
  /** Specific issues found inside the dimension. Empty when clean. */
  issues: string[];
  /** Concrete rewrite or instruction. One sentence. */
  fix: string;
}

export type ShortsQaSeverity = 'critical' | 'major' | 'minor';

export interface ShortsQaCriticalIssue {
  severity: ShortsQaSeverity;
  /** Where in the script (line, range, or "the closing line"). */
  location: string;
  /** What's wrong. */
  issue: string;
  /** The exact rewrite or instruction. */
  fix: string;
  /** When the issue was auto-promoted from a dimension under its
   *  per-dimension floor (rather than emitted directly by the grader),
   *  the originating dimension. Lets the UI pin the issue near its
   *  dimension card and avoids the grader and the floor logic
   *  double-reporting the same problem. Optional. */
  source_dimension?: ShortsQaDimensionKey;
}

export interface ShortsQaRewriteSuggestion {
  /** Exact text quoted from the script. */
  original: string;
  /** The grader's replacement. */
  improved: string;
  /** Why the replacement is better. One sentence. */
  reason: string;
}

/** A claim the grader marked as checkable / risky. After the fact-check
 *  pass runs (`enabled` setting on), the claim carries a verdict +
 *  source URL + one-line reason. When the setting is off OR the
 *  fact-check pass skipped the claim (over the per-run cap), `verdict`
 *  is `'unchecked'` and no URL is present. */
export type ShortsQaFactVerdict =
  | 'verified'
  | 'contradicted'
  | 'inconclusive'
  | 'unchecked';

export interface ShortsQaFlaggedClaim {
  /** The claim quoted verbatim from the script. */
  claim: string;
  /** Coarse pointer back into the script (e.g. "line 4" or "the
   *  closing payoff"). The grader picks this; we don't try to compute
   *  character offsets because LLM-quoted spans rarely line up
   *  byte-for-byte after rewrites. */
  where_in_script: string;
  /** The grader's 1..3 hint about how dangerous the claim is.
   *  3 = high — definitely worth a Brave check.
   *  2 = medium.
   *  1 = low — surfaced for the user but unlikely to be wrong. */
  riskiness: 1 | 2 | 3;
  verdict: ShortsQaFactVerdict;
  /** Set when verdict ∈ {verified, contradicted, inconclusive}. The
   *  best source the judge picked from Brave's top results. */
  source_url?: string;
  /** Set when verdict ∈ {verified, contradicted, inconclusive}. The
   *  judge's one-line explanation. Cap 200 chars. */
  reason?: string;
}

/** The full content-QA result persisted on `shorts.qa_result`. */
export interface ShortsContentQaResult {
  /** 0–100 composite, computed from the dimension scores via the
   *  documented weights minus a fact-check penalty (−5 per
   *  contradicted claim, capped at −20). Rounded to int. */
  composite: number;
  /** One powerful sentence summarising the run. Mirrors the long-form
   *  QA's "verdict" field so the UI vocabulary stays consistent. */
  verdict: string;
  /** Per-dimension scores, keyed by the stable dimension key. Every
   *  dimension in `SHORTS_QA_DIMENSION_KEYS` is present — the
   *  orchestrator fills missing keys with a 0-score + "not graded"
   *  fallback so the UI never has to guard for absence. */
  dimensions: Record<ShortsQaDimensionKey, ShortsQaDimensionScore>;
  /** Critical / major / minor issues. Includes both grader-emitted
   *  issues AND auto-promoted dimension-floor violations. */
  critical_issues: ShortsQaCriticalIssue[];
  /** Verbatim original → improved suggestions. */
  rewrite_suggestions: ShortsQaRewriteSuggestion[];
  /** Claims the grader marked as worth fact-checking, with verdicts. */
  flagged_claims: ShortsQaFlaggedClaim[];
  /** Run-level metadata. */
  meta: {
    /** ISO timestamp the run completed (server clock). */
    run_at: string;
    /** Model id of the grader call. */
    model_id: string;
    /** Composite threshold in effect at run time (Settings). */
    composite_threshold: number;
    /** Per-dimension floor in effect at run time (Settings). */
    per_dimension_floor: number;
    /** Fact-check claim cap in effect at run time (Settings). */
    fact_check_claim_cap: number;
    /** Whether the fact-check pass ran. False when Settings flipped
     *  it off, OR when the grader returned zero flagged claims. */
    fact_check_ran: boolean;
    /** Number of Brave searches performed this run. */
    fact_check_brave_queries: number;
    /** Total run duration in ms — sum of grader + fact-check passes. */
    duration_ms: number;
  };
}

/** Default thresholds & caps. Mirrored in the Settings panel; the
 *  route reads the user's setting and falls back to these. Tweaking
 *  these numbers without updating the Settings copy will silently
 *  drift the UI from the runtime — change both. */
export const SHORTS_QA_DEFAULT_COMPOSITE_THRESHOLD = 80;
export const SHORTS_QA_DEFAULT_PER_DIMENSION_FLOOR = 70;
export const SHORTS_QA_DEFAULT_FACT_CHECK_CLAIM_CAP = 5;
export const SHORTS_QA_DEFAULT_FACT_CHECK_ENABLED = true;

/** Cooldown between consecutive QA runs on the same short. Stops a
 *  mash-clicked Re-run from burning Brave + LLM credits. */
export const SHORTS_QA_RUN_COOLDOWN_MS = 30_000;

/** Human-readable label per dimension. The QA tab uses this to render
 *  dimension cards; centralised so a label rename never desyncs. */
export const SHORTS_QA_DIMENSION_LABELS: Record<ShortsQaDimensionKey, string> = {
  factual_accuracy: 'Factual Accuracy',
  hook_strength: 'Hook Strength',
  content_quality: 'Content Quality',
  payoff_clarity: 'Payoff Clarity',
  audience_targeting: 'Audience Fit',
  pacing_density: 'Pacing & Density',
  caption_readability: 'Caption Readability',
};

/** Dimension weights — sum = 1.0. Tuned together; factual_accuracy
 *  carries the heaviest slice because the user-stated motivation for
 *  this feature is YouTube comments flagging factual mistakes. */
export const SHORTS_QA_DIMENSION_WEIGHTS: Record<ShortsQaDimensionKey, number> = {
  factual_accuracy: 0.30,
  hook_strength: 0.20,
  content_quality: 0.15,
  payoff_clarity: 0.10,
  audience_targeting: 0.10,
  pacing_density: 0.10,
  caption_readability: 0.05,
};
