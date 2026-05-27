/**
 * Stage handler: script generation.
 *
 * Active for stage `generating_script`. Two entry paths converge
 * here:
 *   - Fresh-mode rows arrive after `handleGenerateIdea` wrote
 *     idea_id on the video.
 *   - Existing-mode rows started here with idea_id already set by
 *     `createPipelineRun`.
 *
 * Both paths load the idea from `video_ideas` for its title +
 * description. Creates a `projects` row if the video doesn't have
 * one yet (scripts.project_id is NOT NULL — the project is the
 * organizational unit for the rest of the pipeline). Calls
 * `scriptGenerationPrompt` + `generateTextWithFallback`. Persists
 * the script and computes spoken-word count via the canonical
 * `stripCues` + `countWords` so the gate UI shows the same number
 * as the narrator portal (single source of truth — rule 2).
 *
 * Next state depends on `preset.script_gate_enabled`:
 *   - enabled (default) → `awaiting_script_gate` (cron stops here)
 *   - disabled (fully-unattended preset) → `running_qa`
 */
import { sql } from '@vercel/postgres';
import { scriptGenerationPrompt } from '../../prompts';
import { generateTextWithFallback } from '../../ai';
import { GenerateFailure } from '../../ai-fallback';
import { resolveChain } from '../resolve-chain';
import { persistArtefact } from '../db';
import { countWords } from '../../utils';
import { QA_PRE_CHECK_ENABLED, QA_GENERATOR_V2_ENABLED } from '../../feature-flags';
import { runPreQaSelfCheck } from '../../script-critics/pre-qa-self-check';
import { getWorkspaceQaSettings, resolveToggle } from '../../qa-workspace-settings';
import { resolveStyle } from '../../production-doc-styles';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleGenerateScript(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  if (!video.idea_id) {
    // Should never happen — fresh-mode rows are advanced here only
    // after idea-gen sets the FK; existing-mode rows are created
    // with it. Defensive: fail loud.
    return {
      kind: 'fail',
      terminalStage: 'script_generation_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'generate-script handler reached without idea_id set.',
    };
  }

  // Load the idea — workspace-scoped through the FK chain on
  // pipeline_run_videos (already validated by claimNextVideo).
  const { rows: ideaRows } = await sql.query<{
    title: string;
    description: string | null;
    target_audience: string | null;
    niche: string | null;
  }>(
    `
    SELECT title, description, target_audience, niche
      FROM video_ideas
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [video.idea_id, video.workspace_id],
  );
  if (ideaRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'script_generation_failed',
      failureClass: 'idea_missing',
      failureMessage: `Idea ${video.idea_id} not found (deleted?).`,
    };
  }
  const idea = ideaRows[0];
  const niche = idea.niche || preset.niche || '';
  if (!niche) {
    return {
      kind: 'fail',
      terminalStage: 'script_generation_failed',
      failureClass: 'config_missing',
      failureMessage: 'Niche not available on idea or preset — required for script gen.',
    };
  }

  // Ensure a project exists. Fresh-mode rows have no project_id
  // yet; existing-mode rows might either way (depending on
  // whether the originating idea was tied to a project).
  let projectId = video.project_id;
  if (!projectId) {
    const { rows: pRows } = await sql.query<{ id: string }>(
      `
      INSERT INTO projects (workspace_id, title, niche, topic, status)
      VALUES ($1::uuid, $2, $3, $4, 'in_progress')
      RETURNING id::text AS id
      `,
      [video.workspace_id, idea.title, niche, idea.title],
    );
    projectId = pRows[0].id;
  }

  // Pull preset script rules. All fields optional — the script
  // generator has sensible defaults.
  const rules = (preset.script_rules_jsonb ?? {}) as {
    tone?: string;
    style?: string;
    audience?: string;
    additionalContext?: string;
    referenceContext?: string;
    targetDurationMinutes?: number;
    constraints?: unknown;
  };
  const targetDurationMinutes = rules.targetDurationMinutes ?? guessDurationFromSpokenWords(preset.target_spoken_words);

  const chain = await resolveChain('script-generator', preset);

  // Resolve QA-hardening toggles once: workspace setting overrides env var.
  const qaSettings = await getWorkspaceQaSettings(video.workspace_id).catch(() => null);
  const generatorV2Enabled = resolveToggle(qaSettings?.generatorV2 ?? 'inherit', QA_GENERATOR_V2_ENABLED);
  const preCheckEnabled = resolveToggle(qaSettings?.preCheck ?? 'inherit', QA_PRE_CHECK_ENABLED);

  // Style preset: prefer the dedicated script_style_preset_id when
  // set, otherwise fall back to production_doc_style_id (so a preset
  // that only set the visual style also flavors the script — matches
  // the standalone Script Generator's single-stylePreset UX). Both
  // null → resolvedStyle stays null → prompt is byte-identical to
  // the pre-style code path. Cross-workspace ids return null too.
  const effectiveStyleId = preset.script_style_preset_id ?? preset.production_doc_style_id;
  const resolvedStyle = effectiveStyleId
    ? await resolveStyle(effectiveStyleId, video.workspace_id)
    : null;
  if (effectiveStyleId && !resolvedStyle) {
    logger.warn('[pipeline script-gen] style preset referenced but not resolvable', {
      pipeline_video_id: video.id,
      preset_id: preset.id,
      style_id: effectiveStyleId,
    });
  }

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, (modelId) => {
      const prompt = scriptGenerationPrompt({
        topic: idea.title,
        niche,
        targetDurationMinutes,
        targetAudience: rules.audience ?? idea.target_audience ?? undefined,
        tone: rules.tone,
        style: rules.style,
        additionalContext: rules.additionalContext,
        referenceContext: rules.referenceContext,
        constraints: rules.constraints as never,
        generatorV2Enabled,
        stylePreset: resolvedStyle
          ? {
              label: resolvedStyle.label,
              description: resolvedStyle.description,
              mixing_rules: resolvedStyle.mixing_rules,
            }
          : null,
      });
      return {
        modelId,
        prompt: prompt.user,
        systemPrompt: prompt.system,
        maxTokens: 8000,
        temperature: 0.7,
        spend: {
          workspaceId: video.workspace_id,
          projectId,
          featureArea: 'pipeline_script_generation',
        },
      };
    });
  } catch (err) {
    if (err instanceof GenerateFailure) {
      return {
        kind: 'fail',
        terminalStage: 'script_generation_failed',
        failureClass: err.failureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  // Pre-QA self-check (Lever B of the QA hardening plan). When the
  // QA_PRE_CHECK_ENABLED flag is on, the generator self-criticizes the
  // draft against the same nuclear-mode rubric the critic panel will
  // apply, then rewrites the single weakest section. Resilient: any
  // failure falls back to the original draft. Only runs on first-pass
  // generation — qa_retry has the fix list from the prior verdict and
  // a self-check there would compete with those directives.
  let scriptText = result.text;
  let selfCheckRan: 'kept' | 'rewrote' | 'skipped' | null = null;
  let selfCheckSelfScore: number | null = null;
  if (preCheckEnabled) {
    const selfCheck = await runPreQaSelfCheck({
      scriptText,
      niche,
      modelId: result.modelUsed,
      spend: { workspaceId: video.workspace_id, projectId, sourceScriptId: null },
    });
    selfCheckRan = selfCheck.decision;
    selfCheckSelfScore = selfCheck.selfScore;
    scriptText = selfCheck.scriptText;
    logger.info('[qa pre-check] applied to pipeline', {
      pipeline_video_id: video.id,
      project_id: projectId,
      decision: selfCheck.decision,
      self_score: selfCheck.selfScore,
    });
  }

  // Spoken-word count via the canonical `countWords` helper (which
  // strips production cues internally — single source of truth
  // with the narrator portal so the gate's count is honest).
  const spokenWordCount = countWords(scriptText);
  const estimatedDurationSeconds = Math.round((spokenWordCount / 140) * 60);

  // Persist the script. version = 1 for now (qa_retry bumps this on
  // every regeneration). workspace_id is NOT NULL on scripts since
  // the multi-tenant rollout (migration 0011/0012); inserting without
  // it surfaced as "null value in column workspace_id violates
  // not-null constraint" once the orchestrator started reporting
  // handler crashes instead of silently releasing claims.
  const { rows: sRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO scripts
      (project_id, version, content, word_count, estimated_duration_seconds, ai_model, generation_params, is_active, workspace_id)
    VALUES ($1::uuid, 1, $2, $3, $4, $5, $6::jsonb, true, $7::uuid)
    RETURNING id::text AS id
    `,
    [
      projectId,
      scriptText,
      spokenWordCount,
      estimatedDurationSeconds,
      result.modelUsed,
      JSON.stringify({
        pipeline_run_video_id: video.id,
        fallback_attempts: result.attempts.length,
        pre_qa_self_check: selfCheckRan,
        pre_qa_self_score: selfCheckSelfScore,
      }),
      video.workspace_id,
    ],
  );

  // Persist a per-attempt artefact when the self-check ran so the
  // pipeline detail UI can show "self-check kept|rewrote draft" next
  // to the script-generation step. Skipped/disabled cases are not
  // logged as artefacts to keep the timeline focused on real actions.
  if (selfCheckRan === 'kept' || selfCheckRan === 'rewrote') {
    await persistArtefact({
      pipelineRunVideoId: video.id,
      stage: 'generating_script',
      attemptNumber: 1,
      artefactKind: 'pre_qa_self_check',
      artefactId: sRows[0].id,
      costUsd: 0,
      metadata: {
        decision: selfCheckRan,
        self_score: selfCheckSelfScore,
      },
    });
  }

  const nextStage = preset.script_gate_enabled ? 'awaiting_script_gate' : 'running_qa';

  return {
    kind: 'advance',
    nextStage,
    persist: {
      project_id: projectId,
      script_id: sRows[0].id,
    },
  };
}

/**
 * When the preset specifies target_spoken_words but not duration,
 * derive a minute count assuming 140 wpm (the project's standard
 * speaking pace, matched in `estimateDuration`).
 */
function guessDurationFromSpokenWords(words: number | null): number {
  if (!words || words < 50) return 8; // sane default — 8-minute script
  return Math.max(1, Math.round(words / 140));
}
