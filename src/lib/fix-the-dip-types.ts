/**
 * Client-safe types for the fix-the-dip post-publish analyzer. Same
 * client/server split as retention-predictor-types.
 */
import type { RetentionPoint } from './retention-predictor-types';

export type DipSeverity = 'minor' | 'moderate' | 'major' | 'cliff';

/** A single drop detected in the retention curve, after the LLM has
 *  aligned it to the script and proposed a fix. */
export interface RetentionDip {
  /** Where the drop starts, in seconds from the beginning of the video. */
  start_seconds: number;
  /** Where the drop ends. */
  end_seconds: number;
  /** Retention level just before the dip (0-1). */
  retention_before: number;
  /** Retention level at the dip's nadir (0-1). */
  retention_after: number;
  /** Magnitude of the drop, in percentage points (0-100). */
  drop_pct: number;
  severity: DipSeverity;
  /** The script segment that was on screen during the dip — first ~200 chars. */
  script_excerpt: string;
  /** One-line root-cause hypothesis ("ad break", "jargon wall", "rambling tangent"). */
  why: string;
  /** Concrete edit recommendation. */
  fix: string;
  /** Estimated retention lift if the fix is applied (percentage points). */
  estimated_lift_pct?: number;
}

/** A pattern observed across multiple dips ("3 of your 4 dips happen at
 *  ad breaks — try mid-roll integration"). */
export interface DipPattern {
  pattern: string;
  affected_dip_indices: number[];
  recommendation: string;
}

/** Full analysis result. */
export interface DipAnalysis {
  detected_dips: RetentionDip[];
  top_fixes: string[];
  patterns: DipPattern[];
  /** The video's actual AVP at analysis time, copied for convenience. */
  observed_avp_percentage: number | null;
}

/** Database row shape — mirrors migration 0027's `dip_analyses`. */
export interface DipAnalysisRow {
  id: string;
  workspace_id: string;
  channel_db_id: string | null;
  project_id: string | null;
  source_script_id: string | null;
  youtube_video_id: string;
  video_title: string | null;
  video_duration_seconds: number | null;
  script_text: string;
  retention_curve_snapshot: RetentionPoint[];
  average_view_percentage: number | null;
  detected_dips: RetentionDip[];
  top_fixes: string[];
  patterns: DipPattern[];
  ai_model: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Min drop magnitude (percentage points) to flag as a dip worth analyzing.
 *  Below this, noise dominates signal in real-world curves. */
export const MIN_DIP_DROP_PCT = 4;

/** How many seconds of "decline" max before we treat as a single dip
 *  (rather than a slow general decline). */
export const MAX_DIP_DURATION_SECONDS = 30;

/** Hard cap on dips fed to the LLM — past this many, the model can't keep
 *  per-dip suggestions distinct. */
export const MAX_DIPS_PER_ANALYSIS = 8;
