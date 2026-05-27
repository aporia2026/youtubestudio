/**
 * Shared types + invariants for the auto-pipeline orchestrator.
 *
 * Stage names are persisted to `pipeline_run_videos.stage` as TEXT
 * (migration 0052). TEXT not ENUM so we can add new stages in code
 * without a schema migration. Application code is the only line of
 * defence for valid stage values — keep the union here in sync with
 * the orchestrator's switch.
 *
 * Stage-name convention: each name describes WHAT THE ORCHESTRATOR
 * DOES NEXT when it claims this row. When the cron picks a row at
 * stage 'generating_script', the script-generation handler runs. On
 * handler success the cron advances stage to the next forward value.
 * On failure the cron advances to the appropriate terminal state.
 *
 * 'queued' is the initial state for a fresh row that needs idea
 * generation. Rows seeded with an existing idea start at
 * 'generating_script' instead, skipping the idea-gen handler.
 *
 * `generating_idea` is reserved but currently aliased to `queued` —
 * fresh rows go straight from queued to generating_script via the
 * idea-gen handler. Kept in the union so the plan + the DB stage
 * column can store either name during a future refactor.
 */

export const PIPELINE_STAGES = [
  // ─── active (cron advances these) ─────────────────────────────────
  'queued',
  'generating_idea',
  'generating_script',
  'running_qa',
  'qa_retry',
  'narration_complete',
  'generating_production_doc',
  'generating_thumbnail',
  'assigning_to_editor',
  'generating_seo',
  // ─── waiting on a human (cron skips) ──────────────────────────────
  'awaiting_script_gate',
  'waiting_narration',
  'narration_overdue',
  // ─── terminal (cron skips; UI shows final state) ──────────────────
  'done',
  'idea_generation_failed',
  'script_generation_failed',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cancelled_by_user',
  'cost_cap_exceeded',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages the cron may claim and advance. */
export const ACTIVE_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'queued',
  'generating_idea',
  'generating_script',
  'running_qa',
  'qa_retry',
  'narration_complete',
  'generating_production_doc',
  'generating_thumbnail',
  'assigning_to_editor',
  'generating_seo',
]);

/** Stages where the cron does nothing — a human action moves them. */
export const WAITING_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'awaiting_script_gate',
  'waiting_narration',
  'narration_overdue',
]);

/** Stages from which no further transition is possible. */
export const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'done',
  'idea_generation_failed',
  'script_generation_failed',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cancelled_by_user',
  'cost_cap_exceeded',
]);

/** Terminal failure stages (subset of TERMINAL_STAGES). Useful for
 *  the UI's "failed" filter. */
export const FAILURE_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'idea_generation_failed',
  'script_generation_failed',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cost_cap_exceeded',
]);

export function isActiveStage(s: string): s is PipelineStage {
  return ACTIVE_STAGES.has(s as PipelineStage);
}

export function isTerminalStage(s: string): s is PipelineStage {
  return TERMINAL_STAGES.has(s as PipelineStage);
}

export function isPipelineStage(s: string): s is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(s);
}

// ─── Run + Video DB row shapes ──────────────────────────────────────

export type PipelineRunStatus = 'idea_ranking' | 'running' | 'paused' | 'done' | 'cancelled';

export interface PipelineRunRow {
  id: string;
  workspace_id: string;
  preset_id: string;
  channel_id: string | null;
  ideas_count: number;
  status: PipelineRunStatus;
  estimated_cost_usd: string | null; // numeric → string from pg
  actual_cost_usd: string;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface PipelineRunVideoRow {
  id: string;
  workspace_id: string;
  pipeline_run_id: string;
  priority: number;
  stage: string; // TEXT — validated via isPipelineStage
  retry_count: number;
  failure_class: string | null;
  failure_message: string | null;
  cost_usd: string; // numeric → string
  idea_id: string | null;
  project_id: string | null;
  script_id: string | null;
  critic_panel_id: string | null;
  narrator_assignment_id: string | null;
  production_doc_entry_id: string | null;
  /** Generated thumbnail image URL (Kie.ai returns a URL). No FK
   *  table — image lives at the URL; metadata in
   *  pipeline_stage_artefacts. */
  thumbnail_url: string | null;
  editor_assignment_id: string | null;
  narration_deadline_at: Date | null;
  /** Per-video override for the script-stage style preset. When set,
   *  takes precedence over preset.script_style_preset_id (and over
   *  preset.production_doc_style_id). Null = inherit from the preset
   *  chain. Migration 0094. */
  script_style_preset_override_id: string | null;
  /** Per-video override for the script-rules `additionalContext` block.
   *  When non-null, the script-stage handler substitutes this in place
   *  of preset.script_rules_jsonb.additionalContext. Empty string is a
   *  valid "explicitly clear" override. Migration 0095. */
  script_additional_context_override: string | null;
  /** Per-video override for the visual / production-doc style preset.
   *  When set, takes precedence over preset.production_doc_style_id
   *  inside the production-doc handler. Null = inherit from the
   *  preset. Sibling to script_style_preset_override_id but applies
   *  to the visual side. Migration 0096. */
  production_doc_style_override_id: string | null;
  claimed_at: Date | null;
  claimed_by_tick: string | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Preset shape (the subset the orchestrator needs) ───────────────

export interface PipelinePreset {
  id: string;
  workspace_id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  idea_context_jsonb: Record<string, unknown> | null;
  script_rules_jsonb: Record<string, unknown> | null;
  target_spoken_words: number | null;
  qa_min_score: number;
  qa_max_iterations: number;
  script_gate_enabled: boolean;
  production_doc_style_id: string | null;
  /** FK to production_doc_styles — overrides production_doc_style_id
   *  for the script-generation stage only. Null = fall back to
   *  production_doc_style_id (so a preset that only set the visual
   *  style also flavors the script). Both null = no style preset
   *  injected, prompt is byte-identical to the pre-style path. */
  script_style_preset_id: string | null;
  narration_deadline_days: number;
  fallback_chains_jsonb: Record<string, string[]> | null;
  /** Collaborator id of the video editor who receives the auto-
   *  assignment after thumbnail completion. Null = no auto-assign
   *  (terminal at 'done' instead). */
  video_editor_collaborator_id: string | null;
  /** FK to thumbnail_template_presets — feeds the
   *  generating_thumbnail handler. Null = use built-in defaults. */
  thumbnail_template_id: string | null;
  /** FK to prompt_templates (field_type='seo') — feeds the
   *  generating_seo handler. Null = skip the SEO step entirely
   *  (advance editor → done with no SEO generation). */
  seo_template_id: string | null;
}

// ─── createPipelineRun input ────────────────────────────────────────

export interface CreatePipelineRunInput {
  workspaceId: string;
  presetId: string;
  /** Optional channel scope — passed to brand-kit resolver on script
   *  gen. Null when the user runs a niche-agnostic pipeline. */
  channelId?: string | null;
  /** Number of fresh ideas to brainstorm. Mutually exclusive with
   *  existingIdeaIds — exactly one must be > 0 / non-empty. v1 doesn't
   *  support mixed batches. */
  countToGenerate?: number;
  /** UUIDs of pre-existing video_ideas rows. Each becomes a queued
   *  video starting at stage='generating_script'. Mutually exclusive
   *  with countToGenerate. */
  existingIdeaIds?: string[];
  /** UUIDs of schedule_items rows. For each item, the runner reuses
   *  `idea_id` when present or auto-creates a video_ideas row from
   *  `title`+`notes` when missing. The schedule item is linked back
   *  via `schedule_items.pipeline_run_video_id` and bumped from
   *  status='idea' to 'scripting' (never regressing a more advanced
   *  status). Mutually exclusive with countToGenerate AND
   *  existingIdeaIds. */
  existingScheduleItemIds?: string[];
  /** UUIDs of `projects` rows that already have a saved script AND a
   *  finished narration. Each becomes a video at
   *  `stage='narration_complete'`, with `project_id`/`script_id`
   *  pre-populated from the project and `idea_id` set to the project's
   *  linked idea (or an auto-created stub from `projects.title` if
   *  none). Skips idea/script/QA/narration-wait entirely — the next
   *  cron tick runs the production-doc handler. Mutually exclusive
   *  with all the modes above. */
  existingProjectIds?: string[];
  /** Estimated $ for the pre-run cost preview (LLM-only; image-gen
   *  separate per plan). Optional — UI may show '?' until estimate
   *  is computed. */
  estimatedCostUsd?: number | null;
  /** Created-by collaborator id (the user who clicked "start"). */
  createdBy?: string | null;
}

export interface CreatePipelineRunResult {
  runId: string;
  videoIds: string[];
}

// ─── Stage handler contract ─────────────────────────────────────────

/**
 * Each stage handler returns one of:
 *   - { nextStage } — successful transition; orchestrator UPDATEs
 *     pipeline_run_videos.stage to nextStage.
 *   - { nextStage, persist } — same as above, with FK updates on the
 *     video row (e.g. setting idea_id after idea-gen).
 *   - { failure } — handler hit a non-fallback failure; orchestrator
 *     records failure_class + message and sets stage to the supplied
 *     terminal state.
 */
export type StageOutcome =
  | { kind: 'advance'; nextStage: PipelineStage; persist?: VideoFieldUpdates; costUsd?: number }
  | { kind: 'fail'; terminalStage: PipelineStage; failureClass: string; failureMessage: string; costUsd?: number };

export interface VideoFieldUpdates {
  idea_id?: string | null;
  project_id?: string | null;
  script_id?: string | null;
  critic_panel_id?: string | null;
  narrator_assignment_id?: string | null;
  production_doc_entry_id?: string | null;
  thumbnail_url?: string | null;
  editor_assignment_id?: string | null;
  narration_deadline_at?: Date | null;
  retry_count?: number;
}

export interface StageHandlerContext {
  video: PipelineRunVideoRow;
  preset: PipelinePreset;
  /** Monotonic tick identifier for log correlation. */
  tickId: string;
}

export type StageHandler = (ctx: StageHandlerContext) => Promise<StageOutcome>;
