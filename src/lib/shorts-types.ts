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
  // Phase 15.3 (migration 0110): style picker + per-style asset cache.
  // `style_id` matches a ShortStyleId from src/lib/short-styles.ts. NULL
  // means "user hasn't picked yet". `style_assets` is style-shaped JSONB
  // — see migration 0110 doc for the per-style contracts.
  style_id: string | null;
  style_assets: ShortStyleAssets;
  // Phase 15.11 (migration 0113): caption editor config. JSONB with
  // optional `style` + per-chunk `chunks` overrides. See
  // `ShortsCaptionsConfig` in shorts-render-types.ts. Defaults to {}.
  captions_config: import('./shorts-render-types').ShortsCaptionsConfig;
  // Phase 15.13 (migration 0114): live asset-pipeline progress. Empty
  // `{}` means no job in flight. The asset route writes phase updates
  // here; the editor polls fast (~2s) while populated and renders a
  // progress strip. Cleared back to `{}` on success OR after a 60s
  // grace period so a stale row from a crashed function gets
  // garbage-collected by the next read.
  generation_progress: GenerationProgressState;
  created_at: string;
  updated_at: string;
}

/** Per-step state the Doodle/Paint asset pipeline writes to
 *  `shorts.generation_progress` while running. The editor uses this to
 *  surface "what's happening right now" instead of a silent spinner.
 *
 *  Phases:
 *    - 'planning'  → LLM call to plan the base + variant prompts (~15s)
 *    - 'base'      → Atlas T2I for the base frame (~30-60s)
 *    - 'variant'   → Atlas Edit for one variant, current/total set
 *    - 'done'      → success terminal; row's `style_assets` carries the
 *                    real result. The route clears this back to `{}`
 *                    right after the final UPDATE so the editor stops
 *                    polling fast.
 *    - 'error'     → failure terminal; `error_message` carries a
 *                    human-readable summary. Cleared by the route after
 *                    a 60s grace so the user can read it before the
 *                    strip disappears.
 *
 *  All fields are optional past the phase so a partial blob (e.g. an
 *  old function crashing mid-step) never breaks the renderer. */
export type GenerationProgressPhase = 'planning' | 'base' | 'variant' | 'done' | 'error';

export interface GenerationProgressState {
  /** Empty object = no in-flight job. The state below applies only when
   *  `phase` is set. */
  phase?: GenerationProgressPhase;
  /** Variant index currently being generated (0-based) for the
   *  'variant' phase. Undefined for other phases. */
  current?: number;
  /** Total variants the planner returned for the 'variant' phase.
   *  Undefined for other phases. */
  total?: number;
  /** Short human-readable label for the strip ("Planning shots…",
   *  "Generating variant 3 of 6…"). */
  label?: string;
  /** ISO timestamp the job started. Used to render elapsed time
   *  client-side. */
  started_at?: string;
  /** ISO timestamp of the latest phase update. Lets the editor compute
   *  per-phase elapsed time too. */
  updated_at?: string;
  /** Set only on 'error'. Plain string with the vendor / planner error
   *  message; the namespaced log line is the source of truth on the
   *  server, this is the user-facing summary. */
  error_message?: string;
  /** Optional: which style the job was minting assets for. Used by the
   *  strip to render "Doodle pipeline" vs "Paint pipeline". */
  style_id?: string;
}

/** Per-style assets persisted on `shorts.style_assets` JSONB.
 *  Each style owns its own sub-shape; reader merges defaults so a
 *  partial JSON blob never crashes callers.
 *
 *  Phase 15.12 — the per-frame Shots panel needs the prompts that
 *  produced each frame so the user can re-prompt + regenerate
 *  individual frames. `base_prompt` and per-variant `edit_prompt` are
 *  OPTIONAL for backwards compatibility — rows persisted before the
 *  Shots panel landed have URLs without prompts. The panel surfaces
 *  this state ("prompt not recorded — regenerating will capture one").
 */
export interface ShortStyleAssets {
  /** Doodle vertical (`doodle_explainer_2_short`) — Atlas-generated
   *  base frame + N variant frames timed to caption chunks. */
  doodle?: {
    /** 1080×1536-equivalent base frame URL. */
    base_url: string;
    /** Phase 15.12 — the prompt that produced base_url (full Atlas
     *  prompt with style suffix included). Optional for back-compat. */
    base_prompt?: string;
    /** Variant frames, ordered. Each carries the caption chunk it lines
     *  up with so the renderer can swap frames at chunk boundaries. */
    variants: Array<{
      url: string;
      caption_chunk_start_index: number;
      /** Phase 15.12 — the edit prompt that produced this variant. */
      edit_prompt?: string;
    }>;
  };
  /** Paint vertical (`paint_explainer_v1_short`) — same asset shape as
   *  Doodle, different visual language (paint_explainer_v1 ai_image_suffix). */
  paint?: {
    base_url: string;
    base_prompt?: string;
    variants: Array<{
      url: string;
      caption_chunk_start_index: number;
      edit_prompt?: string;
    }>;
  };
}
