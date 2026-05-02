/**
 * Client-safe types for cross-channel cannibalization detection.
 */

export type CannibalSideKind = 'schedule_item' | 'video';
export type CannibalRiskLevel = 'low' | 'medium' | 'high';
export type CannibalAlertStatus = 'active' | 'dismissed';

/** One side of a detected pair. */
export interface CannibalSide {
  kind: CannibalSideKind;
  /** schedule_item.id or video_analytics.youtube_video_id, depending on kind. */
  ref_id: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string;
  /** When the upload is/was published. Null when truly unknown. */
  publish_at: string | null;
}

/** A row in `cannibalization_alerts`. */
export interface CannibalizationAlertRow {
  id: string;
  workspace_id: string;
  detected_at: string;
  scope_window_start: string;
  scope_window_end: string;
  pair_a: CannibalSide;
  pair_b: CannibalSide;
  similarity_score: number;
  risk_level: CannibalRiskLevel;
  why: string | null;
  recommended_fix: string | null;
  status: CannibalAlertStatus;
  dismissed_at: string | null;
  ai_model: string | null;
  notes: string | null;
}

/** Result of a scan run — what the API returns to the UI. */
export interface CannibalizationScanResult {
  scanned_window_days: number;
  candidates_considered: number;
  pairs_evaluated: number;
  pairs_above_threshold: number;
  alerts_created: CannibalizationAlertRow[];
}

/** Tunables — exported so the UI can show "we scanned X days back" etc. */
export const CANNIBAL_DEFAULT_WINDOW_DAYS = 7;
export const CANNIBAL_DEFAULT_LOOKBACK_DAYS = 21;
export const CANNIBAL_DEFAULT_LOOKAHEAD_DAYS = 21;
/** Pairs below this lexical Jaccard score are NOT sent to the LLM. The
 *  AI step is the expensive part — pre-filtering with cheap math keeps
 *  scan cost roughly proportional to the number of high-risk pairs, not
 *  to the workspace size. */
export const CANNIBAL_LEXICAL_THRESHOLD = 0.18;
/** Hard cap on AI calls per scan — protects the user from a runaway
 *  cost when their workspace happens to have lots of similar titles. */
export const CANNIBAL_MAX_AI_PAIRS = 10;
