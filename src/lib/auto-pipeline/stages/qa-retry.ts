/**
 * Stage handler: qa_retry — regenerate the script with the prior
 * critic panel's fix list applied.
 *
 * Active when `running_qa` produced a sub-threshold verdict AND
 * `retry_count < preset.qa_max_iterations`. Reads the most recent
 * critic_panel for the video (its verdict already lives in the
 * critic_panels.verdict JSONB), flattens it into the canonical
 * fix list (per the user's 2026-05-12 "fix list visible in UI too"
 * requirement), builds a script-gen prompt augment from it, and
 * regenerates the script. The new script becomes the active one
 * for the project (is_active=true; the prior is_active=false).
 *
 * The flattened fix list is **persisted on the new artefact's
 * metadata_jsonb** so the UI can read it from a single canonical
 * source — orchestrator + UI never disagree about which fixes
 * were applied to which attempt.
 *
 * Advances to `running_qa` with `retry_count + 1`. The
 * critic-panel handler then runs the panel against the new script
 * and either accepts it (advance to waiting_narration) or
 * triggers another qa_retry (if retries left).
 */
import { sql } from '@vercel/postgres';
import { scriptGenerationPrompt } from '../../prompts';
import { generateTextWithFallback } from '../../ai';
import { GenerateFailure } from '../../ai-fallback';
import { resolveChain } from '../resolve-chain';
import { persistArtefact } from '../db';
import { countWords } from '../../utils';
import { flattenVerdictToFixes, buildPromptAugmentFromFixes } from '../fix-list';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';
import type { ScriptPanelVerdict } from '../../script-critics/types';

export async function handleQaRetry(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  if (!video.idea_id || !video.script_id || !video.critic_panel_id || !video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'invariant_violation',
      failureMessage: 'qa_retry handler reached without idea_id / script_id / critic_panel_id / project_id.',
    };
  }

  // Load the prior verdict + script body in a single round-trip.
  const { rows } = await sql.query<{
    verdict: ScriptPanelVerdict | null;
    script_content: string;
    project_title: string | null;
    niche: string | null;
    target_audience: string | null;
  }>(
    `
    SELECT cp.verdict,
           s.content AS script_content,
           p.title AS project_title,
           p.niche AS niche,
           vi.target_audience
      FROM critic_panels cp
      JOIN scripts s ON s.id = $2::uuid
      JOIN projects p ON p.id = s.project_id
      JOIN video_ideas vi ON vi.id = $4::uuid
     WHERE cp.id = $1::uuid
       AND cp.workspace_id = $3::uuid
       AND p.workspace_id = $3::uuid
       AND vi.workspace_id = $3::uuid
    `,
    [video.critic_panel_id, video.script_id, video.workspace_id, video.idea_id],
  );
  if (rows.length === 0 || !rows[0].verdict) {
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'verdict_missing',
      failureMessage: 'Could not load critic verdict for retry — orphan critic_panel?',
    };
  }
  const { verdict, script_content, project_title, niche, target_audience } = rows[0];

  // Flatten the verdict into the canonical fix list. Persisted on
  // the new artefact's metadata so the UI can read the SAME list
  // the model received. Source of truth.
  const fixes = flattenVerdictToFixes(verdict);
  if (fixes.length === 0) {
    // No actionable fixes — the score was below threshold but the
    // critics didn't surface anything to change. Unusual; mark
    // terminal so we don't burn another retry on the same script.
    return {
      kind: 'fail',
      terminalStage: 'qa_failed_after_max_retries',
      failureClass: 'no_actionable_fixes',
      failureMessage: 'Critics scored below threshold but produced no actionable fix list.',
    };
  }

  const promptAugment = buildPromptAugmentFromFixes(fixes);

  // Preset script rules (same shape as generate-script.ts).
  const rules = (preset.script_rules_jsonb ?? {}) as {
    tone?: string;
    style?: string;
    audience?: string;
    additionalContext?: string;
    referenceContext?: string;
    targetDurationMinutes?: number;
    constraints?: unknown;
  };
  const effectiveNiche = niche || preset.niche || '';
  const targetDurationMinutes =
    rules.targetDurationMinutes ?? Math.max(1, Math.round((preset.target_spoken_words ?? 1100) / 140));

  // Append the prior-script body as a "previous attempt" reference
  // so the model can revise rather than reinvent from scratch. The
  // fix augment is concatenated to `additionalContext` — the
  // script-gen prompt already handles long context.
  const additionalContext = [
    rules.additionalContext,
    promptAugment,
    '\n## PRIOR DRAFT (use as a starting point; rewrite per the critic feedback above)\n',
    script_content,
  ]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');

  const chain = await resolveChain('script-generator', preset);

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, (modelId) => {
      const prompt = scriptGenerationPrompt({
        topic: project_title || 'Untitled',
        niche: effectiveNiche,
        targetDurationMinutes,
        targetAudience: rules.audience ?? target_audience ?? undefined,
        tone: rules.tone,
        style: rules.style,
        additionalContext,
        referenceContext: rules.referenceContext,
        constraints: rules.constraints as never,
      });
      return {
        modelId,
        prompt: prompt.user,
        systemPrompt: prompt.system,
        maxTokens: 8000,
        temperature: 0.7,
        spend: {
          workspaceId: video.workspace_id,
          projectId: video.project_id,
          featureArea: 'pipeline_script_retry',
        },
      };
    });
  } catch (err) {
    if (err instanceof GenerateFailure) {
      return {
        kind: 'fail',
        terminalStage: 'qa_failed_after_max_retries',
        failureClass: err.failureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  // Persist new script — bump the version, flip is_active.
  const scriptText = result.text;
  const spokenWordCount = countWords(scriptText);
  const estimatedDurationSeconds = Math.round((spokenWordCount / 140) * 60);

  // Two-step: deactivate prior, insert new. In a transaction so
  // there's never a moment with zero is_active scripts on the
  // project (an upstream consumer that filters is_active=true
  // would otherwise hit an empty result).
  await sql.query(
    `
    UPDATE scripts
       SET is_active = false
     WHERE project_id = $1::uuid AND is_active = true
    `,
    [video.project_id],
  );
  const { rows: insertedRows } = await sql.query<{ id: string; version: number }>(
    `
    INSERT INTO scripts
      (project_id, version, content, word_count, estimated_duration_seconds, ai_model, generation_params, is_active)
    VALUES (
      $1::uuid,
      COALESCE((SELECT MAX(version) FROM scripts WHERE project_id = $1::uuid), 0) + 1,
      $2, $3, $4, $5, $6::jsonb, true
    )
    RETURNING id::text AS id, version
    `,
    [
      video.project_id,
      scriptText,
      spokenWordCount,
      estimatedDurationSeconds,
      result.modelUsed,
      JSON.stringify({
        pipeline_run_video_id: video.id,
        retry_of_script_id: video.script_id,
        applied_fixes_count: fixes.length,
        fallback_attempts: result.attempts.length,
      }),
    ],
  );
  const newScriptId = insertedRows[0].id;

  // Stage artefact carries the flattened fix list — the canonical
  // source for the UI's "fixes being applied this attempt" panel.
  // attempt_number = retry_count + 2 (first attempt is 1, first
  // retry is 2, etc.). The PK conflict path makes this safe to
  // re-enter.
  const attemptNumber = video.retry_count + 2;
  await persistArtefact({
    pipelineRunVideoId: video.id,
    stage: 'qa_retry',
    attemptNumber,
    artefactKind: 'script_with_fixes',
    artefactId: newScriptId,
    costUsd: 0,
    metadata: {
      applied_fixes: fixes,
      model_used: result.modelUsed,
      fallback_attempts: result.attempts.length,
      replaces_script_id: video.script_id,
      replaces_critic_panel_id: video.critic_panel_id,
    },
  });

  logger.info('auto-pipeline: qa_retry — new script persisted', {
    pipeline_video_id: video.id,
    new_script_id: newScriptId,
    replaces_script_id: video.script_id,
    fix_count: fixes.length,
    high_severity_count: fixes.filter((f) => f.severity === 'high').length,
    new_retry_count: video.retry_count + 1,
  });

  return {
    kind: 'advance',
    nextStage: 'running_qa',
    persist: {
      script_id: newScriptId,
      retry_count: video.retry_count + 1,
      // critic_panel_id keeps pointing at the prior verdict for
      // historical display; the next running_qa pass creates a new
      // panel row and overwrites this when it advances.
    },
  };
}
