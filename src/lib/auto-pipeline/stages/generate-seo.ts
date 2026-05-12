/**
 * Stage handler: SEO optimization. Added 2026-05-12, runs as the
 * final pre-`done` step.
 *
 * Generates a full SEO package (8 title candidates with per-axis
 * scoring, description with above-the-fold + full body + hashtags,
 * tag list with relevance ranking, chapter timestamps, SEO
 * analysis) from the project's idea + approved script + niche,
 * optionally guided by a saved `prompt_templates` row (the user's
 * "saved SEO template" from the existing /seo page).
 *
 * Skip semantics: when `preset.seo_template_id` is null, the
 * handler advances to `done` without running. The user can opt in
 * by creating a saved SEO template and linking it on the preset.
 *
 * Output persistence: the parsed result lands on
 * `pipeline_stage_artefacts.metadata_jsonb` (artefact_kind='seo_output').
 * No separate `seo_outputs` table — matches the existing app's
 * pattern of writing SEO results to schedule_items when one is
 * linked, but the pipeline doesn't auto-create a schedule_item
 * today so the artefact row is the canonical store.
 */
import { sql } from '@vercel/postgres';
import { seoOptimizationPrompt } from '../../prompts';
import { generateTextWithFallback } from '../../ai';
import { GenerateFailure } from '../../ai-fallback';
import { resolveChain } from '../resolve-chain';
import { persistArtefact } from '../db';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleGenerateSeo(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  // Skip the whole step when no template is linked. The user opts
  // in by configuring a saved SEO template on the preset.
  if (!preset.seo_template_id) {
    logger.info('auto-pipeline: SEO step skipped (no seo_template_id on preset)', {
      pipeline_video_id: video.id,
    });
    return { kind: 'advance', nextStage: 'done' };
  }

  if (!video.idea_id || !video.script_id || !video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'seo_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'SEO handler reached without idea_id / script_id / project_id.',
    };
  }

  // Load the SEO template content. prompt_templates is not
  // workspace-scoped (existing global-table design); we still
  // scope the rest of the query (script, project, idea) through
  // the workspace.
  const { rows: dataRows } = await sql.query<{
    template_content: string | null;
    idea_title: string;
    project_niche: string | null;
    idea_niche: string | null;
    script_content: string;
  }>(
    `
    SELECT pt.content AS template_content,
           vi.title AS idea_title,
           vi.niche AS idea_niche,
           p.niche AS project_niche,
           s.content AS script_content
      FROM scripts s
      JOIN projects p ON p.id = s.project_id
      JOIN video_ideas vi ON vi.id = $2::uuid
      LEFT JOIN prompt_templates pt ON pt.id = $3::uuid
     WHERE s.id = $1::uuid
       AND p.workspace_id = $4::uuid
       AND vi.workspace_id = $4::uuid
    `,
    [video.script_id, video.idea_id, preset.seo_template_id, video.workspace_id],
  );
  if (dataRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'seo_failed',
      failureClass: 'data_missing',
      failureMessage: 'Could not load script + idea for SEO optimization.',
    };
  }
  const row = dataRows[0];
  const niche = row.idea_niche || row.project_niche || preset.niche || '';
  if (!niche) {
    return {
      kind: 'fail',
      terminalStage: 'seo_failed',
      failureClass: 'config_missing',
      failureMessage: 'Niche not available on idea, project, or preset — required for SEO.',
    };
  }

  // The template might have been deleted between preset save and
  // this run (FK is SET NULL on delete, but we read by id directly
  // so we just get null). Continue without it — the SEO step still
  // produces useful output, just without the user's hard rules.
  const templateContent = (row.template_content ?? '').trim();
  const additionalContext = buildSeoAdditionalContext(templateContent);

  const chain = await resolveChain('seo-optimizer', preset);

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, (modelId) => {
      const prompt = seoOptimizationPrompt({
        topic: row.idea_title,
        niche,
        script: row.script_content,
        additionalContext: additionalContext || undefined,
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
          featureArea: 'pipeline_seo_optimize',
        },
      };
    });
  } catch (err) {
    if (err instanceof GenerateFailure) {
      return {
        kind: 'fail',
        terminalStage: 'seo_failed',
        failureClass: err.failureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  // Parse the JSON — strip fences if present.
  let body = result.text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsedSeo: unknown;
  try {
    parsedSeo = JSON.parse(body);
  } catch {
    return {
      kind: 'fail',
      terminalStage: 'seo_failed',
      failureClass: 'empty_or_malformed',
      failureMessage: 'SEO response was not parseable JSON.',
    };
  }

  // Persist the parsed result for the UI + future publish flow.
  await persistArtefact({
    pipelineRunVideoId: video.id,
    stage: 'generating_seo',
    attemptNumber: 1,
    artefactKind: 'seo_output',
    artefactId: null,
    costUsd: 0,
    metadata: {
      seo: parsedSeo,
      template_id: preset.seo_template_id,
      template_applied: templateContent.length > 0,
      model_used: result.modelUsed,
      attempts: result.attempts.length,
    },
  });

  logger.info('auto-pipeline: SEO output persisted', {
    pipeline_video_id: video.id,
    template_id: preset.seo_template_id,
    template_applied: templateContent.length > 0,
    model_used: result.modelUsed,
  });

  return { kind: 'advance', nextStage: 'done' };
}

/**
 * Wrap the saved-template content in the same format the existing
 * /seo page's buildCombinedContext helper uses, so the model
 * applies it under the prompt builder's `USER DIRECTION` rule
 * precedence. Pure; exported for tests.
 *
 * Returns empty string when the template content is blank — the
 * caller passes that as `undefined` to the prompt builder, which
 * skips the USER DIRECTION block entirely.
 */
export function buildSeoAdditionalContext(templateContent: string): string {
  const trimmed = templateContent.trim();
  if (!trimmed) return '';
  return `STYLE / DIRECTION (from saved template):\n${trimmed}`;
}
