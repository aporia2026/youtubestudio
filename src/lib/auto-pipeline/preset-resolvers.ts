/**
 * Resolver helpers that turn a `PipelinePreset` (with optional bundled
 * feature-preset rows joined by db.ts) into the effective config each
 * stage handler needs.
 *
 * The resolution order for every feature:
 *
 *   1. Bundle row (preset.{feature}_preset) — when the pipeline preset
 *      has a feature_preset_id set AND the LEFT JOIN found the row.
 *   2. Inline columns on the pipeline preset — legacy fallback for
 *      presets that haven't been migrated to the bundle yet.
 *   3. Sensible default — when neither is set.
 *
 * Bundle data wins per-field, not per-block. A bundle row with `tone`
 * but no `audience` still gets the inline `audience` from
 * `script_rules_jsonb` — never silently drops a field the user set.
 *
 * The handlers should call these resolvers and forget which path the
 * data came from. Removing inline columns in a future migration is a
 * one-line change here (delete the fallback branch); the handlers
 * stay untouched.
 */
import type { PipelinePreset } from './types';

// ─── Script-rules shape (what `scriptGenerationPrompt` accepts) ─────

export interface ResolvedScriptRules {
  tone?: string;
  style?: string;
  audience?: string;
  additionalContext?: string;
  referenceContext?: string;
  targetDurationMinutes?: number;
  constraints?: unknown;
}

/**
 * Resolves the effective script rules for a pipeline_preset.
 * Preference order per field: bundle.script_preset → inline
 * script_rules_jsonb → undefined.
 */
export function resolveScriptRules(preset: PipelinePreset): ResolvedScriptRules {
  const inline = (preset.script_rules_jsonb ?? {}) as Record<string, unknown>;
  const bundle = preset.script_preset;
  return {
    tone:
      pickString(bundle?.tone) ??
      pickString(inline.tone),
    style:
      pickString(bundle?.style_note) ??
      pickString(inline.style),
    audience:
      pickString(bundle?.audience) ??
      pickString(inline.audience),
    additionalContext:
      pickString(bundle?.additional_context) ??
      pickString(inline.additionalContext),
    referenceContext:
      pickString(bundle?.reference_context) ??
      pickString(inline.referenceContext),
    targetDurationMinutes:
      pickNumber(bundle?.target_duration_minutes) ??
      pickNumber(inline.targetDurationMinutes),
    // Bundle stores unknown keys in constraints_jsonb; inline stored
    // them under the same key. Bundle wins as a whole object.
    constraints: bundle?.constraints_jsonb ?? inline.constraints,
  };
}

/**
 * Script-stage style preset id. The script stage prefers (in order):
 *   1. preset.script_preset.script_style_preset_id (bundle)
 *   2. preset.script_style_preset_id (inline, also called the "per-
 *      preset script style override" from migration 0093)
 *   3. preset.production_doc_style_id (legacy visual-style fallback)
 * Per-video override (video.script_style_preset_override_id) wins
 * over ALL of these — applied separately at the handler.
 */
export function resolveScriptStyleId(preset: PipelinePreset): string | null {
  return (
    preset.script_preset?.script_style_preset_id ??
    preset.script_style_preset_id ??
    preset.production_doc_style_id ??
    null
  );
}

// ─── QA config ──────────────────────────────────────────────────────

export interface ResolvedQaConfig {
  minScore: number;
  maxIterations: number;
  preCheckEnabled: 'on' | 'off' | 'inherit';
  generatorV2Enabled: 'on' | 'off' | 'inherit';
}

export function resolveQaConfig(preset: PipelinePreset): ResolvedQaConfig {
  const bundle = preset.qa_preset;
  return {
    minScore: bundle?.min_score ?? preset.qa_min_score,
    maxIterations: bundle?.max_iterations ?? preset.qa_max_iterations,
    preCheckEnabled: (bundle?.pre_check_enabled ?? 'inherit') as 'on' | 'off' | 'inherit',
    generatorV2Enabled: (bundle?.generator_v2_enabled ?? 'inherit') as 'on' | 'off' | 'inherit',
  };
}

// ─── Narration config ───────────────────────────────────────────────

export interface ResolvedNarrationConfig {
  deadlineDays: number;
  preferredNarratorCollaboratorId: string | null;
  voiceSettings: Record<string, unknown> | null;
}

export function resolveNarrationConfig(preset: PipelinePreset): ResolvedNarrationConfig {
  const bundle = preset.narration_preset;
  return {
    deadlineDays: bundle?.deadline_days ?? preset.narration_deadline_days,
    preferredNarratorCollaboratorId: bundle?.preferred_narrator_collaborator_id ?? null,
    voiceSettings: bundle?.voice_settings_jsonb ?? null,
  };
}

// ─── Idea-gen config ────────────────────────────────────────────────

export interface ResolvedIdeaConfig {
  niche: string | null;
  ideasCountDefault: number;
  focus: 'trending' | 'evergreen' | 'controversial' | 'beginner' | 'mixed' | null;
  audience: string | null;
  videoType: string | null;
  referenceContext: string | null;
  redditContext: string | null;
}

export function resolveIdeaConfig(preset: PipelinePreset): ResolvedIdeaConfig {
  const bundle = preset.idea_preset;
  const inline = (preset.idea_context_jsonb ?? {}) as Record<string, unknown>;
  return {
    niche:
      pickString(bundle?.niche_default) ??
      pickString(preset.niche) ??
      null,
    ideasCountDefault:
      pickNumber(bundle?.ideas_count_default) ??
      preset.ideas_count_default,
    focus: (bundle?.focus ?? pickEnum(inline.focus, ['trending', 'evergreen', 'controversial', 'beginner', 'mixed'])) as ResolvedIdeaConfig['focus'],
    audience:
      pickString(bundle?.audience) ??
      pickString(inline.audience) ??
      null,
    videoType:
      pickString(bundle?.video_type) ??
      pickString(inline.videoType) ??
      null,
    referenceContext:
      pickString(bundle?.reference_context) ??
      pickString(inline.referenceContext) ??
      null,
    redditContext:
      pickString(bundle?.reddit_context) ??
      pickString(inline.redditContext) ??
      null,
  };
}

// ─── Pure pickers (never throw, return undefined for "no value") ────

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
