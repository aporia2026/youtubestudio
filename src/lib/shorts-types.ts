/**
 * Client-safe Shorts types + constants. Mirrors the dubbing-languages split:
 * the orchestrator in `src/lib/shorts.ts` pulls in server-only modules
 * (next/headers via ai.ts), so the row shape and configurable defaults
 * live here for client components to import without dragging the whole
 * pipeline into the browser bundle.
 */

/** Sweet-spot retention for the 2026 Shorts algorithm. Override per-call
 *  via the extract API's `targetSeconds` body field; clamped to 10-90s. */
export const TARGET_DURATION_SECONDS_DEFAULT = 45;

/** Approx spoken-words-per-second for English / multilingual_v2 cadence.
 *  140 WPM ≈ 2.33 wps. Used by both the prompt builder (target word count)
 *  and the duration estimator (after extraction). */
export const WORDS_PER_SECOND = 2.33;

/** Database row shape — mirrors the columns in migration 0021's `shorts` table. */
export interface ShortRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  title: string | null;
  short_script: string;
  hook: string | null;
  payoff: string | null;
  word_count: number | null;
  estimated_duration_seconds: number | null;
  voiceover_audio_url: string | null;
  voiceover_blob_pathname: string | null;
  voiceover_voice_id: string | null;
  voiceover_duration_seconds: number | null;
  rendered_video_url: string | null;
  ai_model: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
