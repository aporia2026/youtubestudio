/**
 * Client-safe types for the retention-curve predictor. Same client/server
 * split as shorts-types / broll-types — server-only modules (next/headers
 * via ai.ts, postgres) live in `src/lib/retention-predictor.ts`; the row
 * shape and shared constants live here so the UI can import them without
 * pulling DB code into the browser bundle.
 */

/**
 * One sample of the predicted retention curve. `position` and `retention`
 * are both 0-1 floats — same shape as `video_analytics.retention_curve`,
 * so the existing `RetentionCurve` SVG component renders predictions
 * with no fork.
 */
export interface RetentionPoint {
  /** 0-1: fractional position through the video (0 = first frame). */
  position: number;
  /** 0-1: fraction of viewers still watching at this position. */
  retention: number;
}

/**
 * Per-script-segment forecast. Segments are derived from natural breaks in
 * the script (paragraphs, [VISUAL] markers, time stamps). The model maps
 * each to an estimated viewer drop and a one-line "why".
 */
export interface SegmentExplanation {
  /** Approximate timecode where this segment plays, in seconds from start. */
  start_seconds: number;
  end_seconds: number;
  /** First ~120 chars of the script segment so the UI can show what the
   *  forecast refers to without the user having to count words. */
  excerpt: string;
  /** Predicted percentage-point drop across this segment (0-100). */
  predicted_drop_pct: number;
  /** Short reason ("rambling intro", "second ad break", "complex jargon"). */
  reason: string;
  /** Concrete fix the user could apply ("cut the first 8 seconds", "add an
   *  analogy after the term 'cosine similarity'"). Optional — empty when
   *  the segment is healthy. */
  fix?: string;
}

/**
 * Full prediction result — what the API returns and what the UI renders.
 * Mirrors the shape persisted in `retention_predictions`.
 */
export interface RetentionPrediction {
  curve: RetentionPoint[];
  predicted_avd_percentage: number;
  predicted_avd_seconds: number;
  segment_explanations: SegmentExplanation[];
  /** The single segment with the largest predicted drop. The UI surfaces
   *  this as the headline finding. Null when the curve is fully flat
   *  (rare; typically the cold open dominates). */
  biggest_drop: SegmentExplanation | null;
  /** 1-3 cross-segment fixes that would lift the overall curve, ranked
   *  by expected impact. Distinct from per-segment `fix` — these are
   *  global ("trim the intro", "add a B-roll cut every 12s"). */
  suggested_fixes: string[];
  /** YouTube video ids of the past videos used as few-shot RAG context.
   *  Empty when the workspace has no published-video history yet. */
  few_shot_video_ids: string[];
  /** Number of few-shot examples used. May be < few_shot_video_ids.length
   *  if some history rows had unusable retention curves. */
  few_shot_count: number;
}

/** Database row shape — mirrors migration 0026's `retention_predictions`. */
export interface RetentionPredictionRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  channel_db_id: string | null;
  script_text: string;
  niche: string | null;
  word_count: number | null;
  estimated_duration_seconds: number | null;
  predicted_curve: RetentionPoint[];
  predicted_avd_percentage: number | null;
  predicted_avd_seconds: number | null;
  segment_explanations: SegmentExplanation[];
  biggest_drop: SegmentExplanation | null;
  suggested_fixes: string[];
  few_shot_video_ids: string[];
  few_shot_count: number;
  ai_model: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Shared with the duration estimator — kept in sync with shorts-types. */
export const RETENTION_WORDS_PER_SECOND = 2.33;

/** Max history examples we'll seed into a single prediction. More is not
 *  always better — past 5-6 examples the prompt grows expensive without
 *  improving accuracy in early benchmarking. */
export const MAX_FEW_SHOT_EXAMPLES = 5;

/** Minimum script length we'll attempt a prediction for (short scripts
 *  give the model nothing to forecast against). */
export const MIN_SCRIPT_CHARS = 400;
