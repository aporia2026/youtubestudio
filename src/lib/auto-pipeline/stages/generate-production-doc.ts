/**
 * Stage handler: production doc generation.
 *
 * Active for stage `generating_production_doc`. Loads the
 * approved script + (when available) the narrator's actual full-
 * audio length, calls `productionDocPrompt` +
 * `generateTextWithFallback`, parses the JSON result, and stores
 * it on `pipeline_stage_artefacts.metadata_jsonb` (v1 has no
 * dedicated `production_doc_entries` table — the doc is JSONB on
 * the artefact row; a future migration can promote it).
 *
 * `production_doc_entry_id` stays null in v1 for that reason. The
 * thumbnail + editor handlers read the prod doc back from the
 * latest artefact for this stage.
 *
 * Advances to `generating_thumbnail` on success (stage added
 * 2026-05-12 per the user's mid-build request for an explicit
 * thumbnail step before editor assignment).
 */
import { sql } from '@vercel/postgres';
import { productionDocPrompt } from '../../prompts';
import { extractScriptTitles } from '../../script-titles';
import { preprocessSsmlForProductionDoc } from '../../ssml-production-doc';
import { generateTextWithFallback } from '../../ai';
import { GenerateFailure } from '../../ai-fallback';
import { resolveChain } from '../resolve-chain';
import { persistArtefact } from '../db';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleGenerateProductionDoc(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  if (!video.script_id || !video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'production_doc_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'production-doc handler reached without script_id or project_id.',
    };
  }

  // Load the script body + niche from the project row.
  const { rows: scriptRows } = await sql.query<{ content: string; niche: string | null; title: string | null }>(
    `
    SELECT s.content,
           COALESCE(p.niche, '') AS niche,
           p.title
      FROM scripts s
      JOIN projects p ON p.id = s.project_id
     WHERE s.id = $1::uuid AND p.workspace_id = $2::uuid
    `,
    [video.script_id, video.workspace_id],
  );
  if (scriptRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'production_doc_failed',
      failureClass: 'script_missing',
      failureMessage: `Script ${video.script_id} not found.`,
    };
  }
  const script = scriptRows[0].content;
  const niche = scriptRows[0].niche || preset.niche || '';
  const topic = scriptRows[0].title || undefined;

  // Resolve the production-doc style (if the preset references
  // one). Pure DB read — null when no style is configured.
  let style: { id: string; ai_image_suffix: string | null; mixing_rules: string | null; allow_overlay_stock: boolean | null } | null = null;
  if (preset.production_doc_style_id) {
    const { rows } = await sql.query<{ id: string; ai_image_suffix: string | null; mixing_rules: string | null; allow_overlay_stock: boolean | null }>(
      `
      SELECT id::text AS id, ai_image_suffix, mixing_rules, allow_overlay_stock
        FROM production_doc_styles
       WHERE id = $1::uuid AND workspace_id = $2::uuid
      `,
      [preset.production_doc_style_id, video.workspace_id],
    );
    if (rows.length > 0) style = rows[0];
  }

  const chain = await resolveChain('production-doc', preset);

  // SSML preprocessor — same logic as the user-facing route. Auto-
  // detects SSML scripts (<speak>...<break time="2s"/>...) and
  // extracts authoritative section boundaries so the LLM honors the
  // user's authored beat structure instead of inferring it.
  const ssmlPre = preprocessSsmlForProductionDoc(script);
  const scriptForPipeline = ssmlPre.wasSsml ? ssmlPre.cleanScript : script;

  // Same deterministic title pre-pass as the user-facing routes — strip
  // `##Heading` lines into sentinel tokens server-side so the LLM doesn't
  // have to detect them itself.
  const extracted = extractScriptTitles(scriptForPipeline);

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, (modelId) => {
      const prompt = productionDocPrompt({
        script: extracted.stripped,
        titles: extracted.titles,
        ssmlSections: ssmlPre.wasSsml ? ssmlPre.sections : undefined,
        niche,
        topic,
        style: style
          ? {
              id: style.id,
              label: '',
              ai_image_suffix: style.ai_image_suffix ?? '',
              mixing_rules: style.mixing_rules ?? undefined,
              allow_overlay_stock: style.allow_overlay_stock === true,
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
          projectId: video.project_id,
          featureArea: 'pipeline_production_doc',
        },
      };
    });
  } catch (err) {
    if (err instanceof GenerateFailure) {
      return {
        kind: 'fail',
        terminalStage: 'production_doc_failed',
        failureClass: err.failureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  // Parse the model's JSON. Strip fences if any.
  let body = result.text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsedDoc: unknown;
  try {
    parsedDoc = JSON.parse(body);
  } catch {
    return {
      kind: 'fail',
      terminalStage: 'production_doc_failed',
      failureClass: 'empty_or_malformed',
      failureMessage: 'Production doc response was not parseable JSON.',
    };
  }

  // Stamp the doc-level on-screen-text mode default to 'overlay' for new
  // docs — Phase 5 default. Rows that didn't pick a per-row override fall
  // back to this, which means generated images come out clean (no diffusion
  // text garbling) and the LowerThird renders the legible text at composite
  // time. Existing docs without this field still default to 'bake' via the
  // renderer's fallback, preserving back-compat. See
  // `_plans/2026-05-21-phase-5-text-mode-toggle.md`.
  if (parsedDoc && typeof parsedDoc === 'object' && !Array.isArray(parsedDoc)) {
    const docObj = parsedDoc as Record<string, unknown>;
    if (docObj.on_screen_text_mode_default === undefined) {
      docObj.on_screen_text_mode_default = 'overlay';
    }
  }

  // Stage 3.0 — detect variant groups whose base row has an empty
  // `ai_image_prompt`. The auto-pipeline path runs the same LLM as the
  // manual /api/generate/production-doc route, so the same bug
  // hypothesis applies here. Logs only; no repair (see
  // `_plans/2026-05-27-doodle-explainer-2-foundation.md` for the
  // detection-first reasoning). Lazy-import the postprocess helper so
  // this stage's existing import graph is unchanged.
  if (parsedDoc && typeof parsedDoc === 'object' && !Array.isArray(parsedDoc)) {
    const docObj = parsedDoc as Record<string, unknown>;
    const rows = docObj.rows;
    if (Array.isArray(rows)) {
      const { detectEmptyVariantGroupBases } = await import('../../production-doc-postprocess');
      // Cast through `unknown` because the auto-pipeline doesn't know the
      // strict ProductionDocRowLike shape at this point — but the
      // detection helper only reads `group_id`, `variant_index`, and
      // `ai_image_prompt` via the index signature, so missing
      // timecode/script_text fields don't affect correctness.
      const detection = detectEmptyVariantGroupBases(
        rows as unknown as Parameters<typeof detectEmptyVariantGroupBases>[0],
      );
      if (detection.emptyBaseGroupIds.length > 0) {
        logger.warn('auto-pipeline: empty-variant-bases', {
          pipeline_video_id: video.id,
          style_id: style?.id ?? null,
          totalGroupsChecked: detection.totalGroupsChecked,
          emptyBaseGroupCount: detection.emptyBaseGroupIds.length,
          emptyBaseGroupIds: detection.emptyBaseGroupIds,
        });
      }
    }
  }

  // Persist the parsed doc onto the artefact row. v1 — no
  // dedicated production_doc_entries table.
  await persistArtefact({
    pipelineRunVideoId: video.id,
    stage: 'generating_production_doc',
    attemptNumber: 1,
    artefactKind: 'production_doc',
    artefactId: null,
    costUsd: 0,
    metadata: { doc: parsedDoc, model_used: result.modelUsed, attempts: result.attempts.length },
  });

  logger.info('auto-pipeline: production doc persisted', {
    pipeline_video_id: video.id,
    model_used: result.modelUsed,
  });

  return { kind: 'advance', nextStage: 'generating_thumbnail' };
}
