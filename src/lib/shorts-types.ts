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

/** Discriminates the kinds of `shorts` rows (migrations 0108 + 0109):
 *  - 'extracted'                  — cut from a long-form script by the
 *                                    extractor OR by Phase 1's auto-fan-out;
 *                                    has `short_script`, can be voiced +
 *                                    rendered.
 *  - 'external_seo'               — a Short the user already made elsewhere,
 *                                    entered by hand for SEO optimization;
 *                                    carries `source_title` /
 *                                    `source_description` and the graded
 *                                    `seo_result`, no `short_script`.
 *  - 'channel_clip_recommendation' — Mode A: a clippable moment inside an
 *                                    existing channel video. Carries
 *                                    `source_youtube_video_id` +
 *                                    `clip_start_ms` + `clip_end_ms`, no
 *                                    `short_script` (the user cuts it in
 *                                    YouTube Studio). */
export type ShortKind = 'extracted' | 'external_seo' | 'channel_clip_recommendation';

/** Content medium for a `shorts` row (migration 0109). See
 *  `src/lib/content-medium.ts` for the full primitive and `_plans/2026-06-02-shorts-everywhere-v1.md` §5 for rationale. */
export type ShortMedium = 'long_form' | 'short_clip' | 'short_native';

/** One graded suggestion (title or description). Score is a 0-100
 *  composite the model assigns; `rationale` is a one-line "why". */
export interface GradedSuggestion {
  text: string;
  score: number;
  rationale: string;
}

/** One graded hashtag set — tags are stored WITHOUT the leading '#'
 *  (the UI prepends it), matching the SEO Optimizer's hashtag convention. */
export interface GradedHashtagSet {
  tags: string[];
  score: number;
  rationale: string;
}

/** Structured output of the Shorts SEO optimizer — a few graded options
 *  for each field so the user can pick. Persisted as `shorts.seo_result`
 *  (JSONB) and rendered by the external-SEO branch of the Short card. */
export interface ShortSeoResult {
  primary_keyword: string;
  titles: GradedSuggestion[];
  descriptions: GradedSuggestion[];
  hashtag_sets: GradedHashtagSet[];
  notes: string;
}

/** Database row shape — mirrors the columns in the `shorts` table
 *  (migration 0021 + the SEO columns added in 0108 + the medium primitive
 *  columns added in 0109). */
export interface ShortRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_script_id: string | null;
  kind: ShortKind;
  medium: ShortMedium;
  title: string | null;
  short_script: string | null;
  hook: string | null;
  payoff: string | null;
  word_count: number | null;
  estimated_duration_seconds: number | null;
  source_title: string | null;
  source_description: string | null;
  seo_result: ShortSeoResult | null;
  voiceover_audio_url: string | null;
  voiceover_blob_pathname: string | null;
  voiceover_voice_id: string | null;
  voiceover_duration_seconds: number | null;
  rendered_video_url: string | null;
  ai_model: string | null;
  notes: string | null;
  // Phase 1 (migration 0109): Mode A + auto-fan-out fields. Nullable on
  // rows that predate the column.
  hook_score: number | null;
  dismissed_at: string | null;
  source_youtube_video_id: string | null;
  clip_start_ms: number | null;
  clip_end_ms: number | null;
  created_at: string;
  updated_at: string;
}
