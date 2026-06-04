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
  // Migration 0117: optional creator-supplied prompt steer for the
  // Doodle/Paint asset planner. Null = no extra context; the planner
  // omits the block. See `_plans/2026-06-04-shorts-captions-position-
  // and-assets-context.md`.
  assets_context: string | null;
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
export type GenerationProgressPhase =
  /** Phase 15.16 — enqueued by the route, waiting for the background cron
   *  to claim it. The work itself runs on the cron, not the request. */
  | 'queued'
  | 'planning'
  | 'base'
  | 'variant'
  | 'done'
  | 'error';

/**
 * Phase 15.16 — durable work-state the background cron carries between
 * ticks, persisted under `GenerationProgressState.job`. Lets a tick resume
 * exactly where the previous one stopped: the planner output is kept so we
 * never re-pay for the LLM call, and per-variant attempt/error counts let
 * the cron stop retrying a deterministically-failing variant and finalize
 * with partial success (render with what succeeded).
 *
 * Finished base + variants live on `shorts.style_assets` (where the
 * renderer reads them), not here — this is scheduling state, not assets.
 */
export interface ShortsAssetJobState {
  /** Planner's base scene prompt, persisted so re-ticks skip the LLM. */
  base_prompt?: string;
  /** Planner's variant edit prompts + their caption-chunk anchors. */
  variant_plan?: Array<{ caption_chunk_start_index: number; edit_prompt: string }>;
  /** Attempt count per variant, keyed by caption_chunk_start_index (as a
   *  string). The cron stops retrying once a variant hits the cap. */
  variant_attempts?: Record<string, number>;
  /** Last error per variant, keyed the same way — for self-diagnosis. */
  variant_errors?: Record<string, string>;
  /** Resolved niche, carried so re-planning (if ever needed) is stable. */
  niche?: string;
  /** Resolved vendor/model choices, carried across ticks. Stashed by the
   *  enqueue route (which has the user session for settings) so the cron
   *  never needs to re-resolve them. */
  base_t2i_model_id?: string;
  variant_edit_primary?: 'atlas' | 'kie';
  /** Variant count cap requested at enqueue time. */
  max_variants?: number;
  /** Running cost tally across ticks, informational. */
  cost_usd?: number;
}

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
  /** Phase 15.16 — durable cron work-state. Absent for the legacy
   *  synchronous path; present once the background cron owns the job. */
  job?: ShortsAssetJobState;
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
    /** Phase 15.16 — i2v animation generated from `base_url`. When
     *  present, the renderer (Phase 15.17) plays the mp4 in place of
     *  the still during the base's window. The still stays as the
     *  thumbnail / fallback for non-video surfaces. Optional. */
    base_animation?: ShortFrameAnimation;
    /** Variant frames, ordered. Each carries the caption chunk it lines
     *  up with so the renderer can swap frames at chunk boundaries. */
    variants: ShortFrameVariant[];
  };
  /** Paint vertical (`paint_explainer_v1_short`) — same asset shape as
   *  Doodle, different visual language (paint_explainer_v1 ai_image_suffix). */
  paint?: {
    base_url: string;
    base_prompt?: string;
    base_animation?: ShortFrameAnimation;
    variants: ShortFrameVariant[];
  };
}

/** Shared variant shape across the Doodle + Paint sub-blocks. Lives as
 *  its own export so callers (orchestrators, route helpers, tests) can
 *  reference it without restating the literal. Per Phase 15.18 (motion
 *  collage), `collage` is the optional sibling of the per-frame
 *  animation field. */
export interface ShortFrameVariant {
  /** Composed image URL — for single-image variants this is the Atlas
   *  Edit output; for collage variants this is the 2×2 grid composed
   *  server-side and uploaded to R2. The renderer is collage-agnostic
   *  (just treats it as an image), so this field is the source of
   *  truth for what gets rendered. */
  url: string;
  caption_chunk_start_index: number;
  /** Phase 15.12 — the edit prompt that produced this variant (single)
   *  or the brief that planned the collage (multi-panel). */
  edit_prompt?: string;
  /** Phase 15.16 — i2v animation generated from `url`. */
  animation?: ShortFrameAnimation;
  /** Phase 15.18 — multi-panel collage metadata. When present, the
   *  variant is a 2×2 grid whose per-panel prompts + source URLs are
   *  tracked so a future per-panel-regen surface can rebuild a single
   *  cell instead of the whole composition. The composed grid lives at
   *  `url` (renderer-facing); the per-panel pieces live here. */
  collage?: ShortFrameCollage;
}

/** Phase 15.18 — per-frame motion collage metadata. The composed image
 *  lives on the parent variant's `url`. */
export interface ShortFrameCollage {
  /** Grid dimensions. v1 ships only `{ cols: 2, rows: 2 }`; the field
   *  exists so a future commit can expand to 3×3 / 1×4 / 2×1 without a
   *  type churn. */
  grid: { cols: number; rows: number };
  /** Per-panel source images, ordered row-major (panel 0 = top-left,
   *  panel 1 = top-right, panel 2 = bottom-left, panel 3 =
   *  bottom-right for the canonical 2×2). */
  panels: Array<{
    url: string;
    prompt: string;
    /** Underlying base-T2I model id the panel was generated with.
     *  Lets the UI surface "this panel cost $X" without a side lookup. */
    model_id: string;
    cost_usd: number;
  }>;
  /** Composed image dimensions, useful for debugging + future tooling. */
  composed_width: number;
  composed_height: number;
  /** ISO timestamp the composition completed. */
  generated_at: string;
}

/** Phase 15.16 — per-frame image-to-video animation metadata. Every
 *  field is required after the animation lands so the renderer + the
 *  UI cost surfacing both have what they need; nothing here is
 *  back-compat optional. */
export interface ShortFrameAnimation {
  /** mp4 URL returned by the i2v provider. The renderer plays this
   *  during the frame's caption window when present. */
  video_url: string;
  /** Vendor thumbnail URL (when the provider returns one). Used by
   *  the Shots panel preview before the user clicks play. */
  thumbnail_url?: string;
  /** Underlying b-roll model id used to generate this animation. Lets
   *  the Shots panel display "Animated with X" without a side lookup. */
  model_id: string;
  /** Flat cost USD recorded at generation time. Surfaced in the UI so
   *  the user can see what each animation cost without a roundtrip
   *  through the spend log. */
  cost_usd: number;
  /** Duration the model was asked to produce, in seconds. Lets the
   *  renderer decide whether to loop / freeze the last frame when the
   *  caption window outlasts the clip. */
  duration_s: number;
  /** ISO timestamp the animation was generated. Useful for ordering
   *  / regen-vs-old detection in the Shots panel. */
  generated_at: string;
  /** Provider task id (Kie taskId) used as the audit trail when
   *  something goes wrong post-success. */
  provider_request_id: string;
}
