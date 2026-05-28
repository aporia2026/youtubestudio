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
import {
  getEffectiveAiImageSuffix,
  getEffectiveMixingRules,
} from '../../production-doc-flags';
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

  // Resolve the visual style (migration 0096 layered the per-video
  // override on top of the per-preset value):
  //
  //   1. video.production_doc_style_override_id  (per-video — new)
  //   2. preset.production_doc_style_id          (per-preset)
  //   3. null                                     (no style)
  //
  // First non-null wins. Cross-workspace ids return null via the
  // SELECT's workspace filter. When both are null, no style is
  // injected and the prompt is byte-identical to the pre-style path.
  const effectiveVisualStyleId =
    video.production_doc_style_override_id ?? preset.production_doc_style_id;
  let style: { id: string; ai_image_suffix: string | null; mixing_rules: string | null; allow_overlay_stock: boolean | null } | null = null;
  if (effectiveVisualStyleId) {
    const { rows } = await sql.query<{ id: string; ai_image_suffix: string | null; mixing_rules: string | null; allow_overlay_stock: boolean | null }>(
      `
      SELECT id::text AS id, ai_image_suffix, mixing_rules, allow_overlay_stock
        FROM production_doc_styles
       WHERE id = $1::uuid AND workspace_id = $2::uuid
      `,
      [effectiveVisualStyleId, video.workspace_id],
    );
    if (rows.length > 0) {
      style = rows[0];
    } else {
      logger.warn('[pipeline production-doc] style referenced but not resolvable', {
        pipeline_video_id: video.id,
        preset_id: preset.id,
        style_id: effectiveVisualStyleId,
        source: video.production_doc_style_override_id ? 'video_override' : 'preset',
      });
    }
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

  // Build the call args once — both the first attempt and the strict
  // retry use the same prompt, just at different temperatures. Pulled
  // out so the retry path is a one-liner that flips temperature.
  const buildCall = (temperature: number) => (modelId: string) => {
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
            // Stage 1 — flag-gated trim of ai_image_suffix +
            // mixing_rules for ref-bearing styles. See
            // `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
            ai_image_suffix: getEffectiveAiImageSuffix({
              id: style.id,
              ai_image_suffix: style.ai_image_suffix ?? '',
            }),
            mixing_rules: getEffectiveMixingRules({
              id: style.id,
              mixing_rules: style.mixing_rules,
            }),
            allow_overlay_stock: style.allow_overlay_stock === true,
          }
        : null,
    });
    return {
      modelId,
      prompt: prompt.user,
      systemPrompt: prompt.system,
      maxTokens: 8000,
      temperature,
      spend: {
        workspaceId: video.workspace_id,
        projectId: video.project_id,
        featureArea: 'pipeline_production_doc',
      },
    };
  };

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, buildCall(0.7));
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

  // Robust JSON extraction. The naive `JSON.parse(body)` path was
  // failing in production on outputs like:
  //   "Here's the production doc:\n\n{ ... }\n\nLet me know..."
  // — perfectly valid JSON wrapped in prose preamble/postamble that
  // breaks the strict parser. extractJson strips fences, tries direct
  // parse first, and falls back to a balanced-brace scan that finds
  // the outermost {...} or [...] substring and parses THAT.
  let parsedDoc = extractJson(result.text);
  let retryRawText: string | null = null;
  let retryModelUsed: string | null = null;

  // If the parser still couldn't find valid JSON, one retry at a
  // lower temperature. Same prompt, just more deterministic. Doesn't
  // count as a separate "stage" — same persistArtefact slot at
  // attempt_number=1 still owns the eventual success. Skipped when
  // the first call hit a hard provider error (handled above).
  if (parsedDoc === null) {
    logger.warn('auto-pipeline: production-doc first-pass unparseable; retrying at temperature 0.3', {
      pipeline_video_id: video.id,
      response_chars: result.text.length,
      model_used: result.modelUsed,
    });
    try {
      const retry = await generateTextWithFallback(chain, buildCall(0.3));
      retryRawText = retry.text;
      retryModelUsed = retry.modelUsed;
      parsedDoc = extractJson(retry.text);
    } catch (err) {
      logger.warn('auto-pipeline: production-doc retry threw', {
        pipeline_video_id: video.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (parsedDoc === null) {
    // Both attempts failed. Persist the raw responses as an artefact
    // so the user / debugger can see what came back instead of the
    // info disappearing into the logs only. attempt_number=1 +
    // artefact_kind='production_doc_unparseable' keeps it distinct
    // from a successful 'production_doc' artefact.
    await persistArtefact({
      pipelineRunVideoId: video.id,
      stage: 'generating_production_doc',
      attemptNumber: 1,
      artefactKind: 'production_doc_unparseable',
      artefactId: null,
      costUsd: 0,
      metadata: {
        first_pass_response: result.text.slice(0, 20000),
        first_pass_model: result.modelUsed,
        retry_response: retryRawText ? retryRawText.slice(0, 20000) : null,
        retry_model: retryModelUsed,
      },
    });
    return {
      kind: 'fail',
      terminalStage: 'production_doc_failed',
      failureClass: 'empty_or_malformed',
      failureMessage: 'Production doc response was not parseable JSON (after one retry). Raw output saved to artefacts.',
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

  // Stage 4 — post-process consistency with the manual /api/generate/
  // production-doc route. The auto-pipeline path was previously skipping
  // attachStyleSuffixToRows, autoGroupVariants, and the variant-prompt
  // refiner, so pipeline-generated docs ended up with raw LLM-emitted
  // ai_image_prompts (no suffix), no variant-group collapses, and
  // unrefined edit instructions — visually worse than manual-route docs
  // for ref-bearing styles. Mirroring the manual chain here closes the
  // gap. See `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
  if (parsedDoc && typeof parsedDoc === 'object' && !Array.isArray(parsedDoc) && style) {
    const docObj = parsedDoc as Record<string, unknown>;
    const rows = docObj.rows;
    if (Array.isArray(rows)) {
      // 1) Suffix attach — uses the EFFECTIVE suffix (post-trim-flag) so
      //    the pipeline and the manual route produce byte-identical rows
      //    for the same style/flag combo.
      const effectiveSuffix = getEffectiveAiImageSuffix({
        id: style.id,
        ai_image_suffix: style.ai_image_suffix ?? '',
      });
      if (effectiveSuffix) {
        const { attachStyleSuffixToRows } = await import('../../production-doc-postprocess');
        const attach = attachStyleSuffixToRows(
          rows as unknown as Parameters<typeof attachStyleSuffixToRows>[0],
          effectiveSuffix,
        );
        logger.info('auto-pipeline: suffix-attach', {
          pipeline_video_id: video.id,
          style_id: style.id,
          attached_count: attach.attachedCount,
          skipped_already_present: attach.skippedAlreadyPresent,
          suffix_chars: effectiveSuffix.length,
        });
      }

      // 2) Auto-group consecutive similar rows into variant groups.
      //    Gated on doodle_explainer_2 (only style with variant-group
      //    mixing rules today). Mirrors the manual route's gate.
      if (style.id === 'doodle_explainer_2') {
        const { autoGroupVariants } = await import('../../auto-group-variants');
        const grouped = autoGroupVariants(
          rows as unknown as Parameters<typeof autoGroupVariants>[0],
        );
        if (grouped.groupCount > 0) {
          logger.info('auto-pipeline: auto-group-variants', {
            pipeline_video_id: video.id,
            style_id: style.id,
            group_count: grouped.groupCount,
            merged_row_count: grouped.mergedRowCount,
            // Phase 1.5 (Bug B): identical-prompt promotions. See the
            // matching field in the manual /api/generate/production-doc
            // route log for diagnosis guidance.
            identical_prompt_merges: grouped.identicalPromptMerges,
          });
        }
        // Phase 1.6 (Bug 3) — variant-index collision dedup. Mirrors
        // the manual route. Drops duplicates, renumbers different-
        // content collisions, recovers missing bases. Spec:
        // _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-3).
        const { dedupVariantIndexCollisions } = await import('../../production-doc-postprocess');
        const dedup = dedupVariantIndexCollisions(
          rows as unknown as Parameters<typeof dedupVariantIndexCollisions>[0],
        );
        if (dedup.collisionsResolved > 0 || dedup.basesRecovered > 0 || dedup.warnings.length > 0) {
          logger.info('auto-pipeline: variant-index-dedup', {
            pipeline_video_id: video.id,
            style_id: style.id,
            collisions_resolved: dedup.collisionsResolved,
            duplicates_dropped: dedup.duplicatesDropped,
            renumbered: dedup.renumbered,
            bases_recovered: dedup.basesRecovered,
            warning_count: dedup.warnings.length,
            warning_sample: dedup.warnings.slice(0, 3),
          });
        }
        if (dedup.duplicatesDropped > 0) {
          // Drops invalidate the local rows reference. Reassign so the
          // downstream refiner + image-gen stages see the cleaned list.
          rows.length = 0;
          rows.push(...(dedup.rows as unknown as typeof rows));
        }
      }

      // 3) Variant-prompt refiner — gated by USE_REFINED_VARIANT_PROMPT
      //    env var, same as the manual route. Rewrites each variant's
      //    vague auto-grouper output into a concrete edit instruction
      //    the GPT Image 2 Edit model can actually act on.
      const { useRefinedVariantPrompt } = await import('../../production-doc-flags');
      if (useRefinedVariantPrompt()) {
        const { refineVariantPromptsInDoc } = await import('../../variant-prompt-refiner');
        const refinement = await refineVariantPromptsInDoc({
          rows: rows as unknown as Parameters<typeof refineVariantPromptsInDoc>[0]['rows'],
          // The auto-pipeline doesn't load style.label (only id + suffix
          // + mixing_rules per the SELECT above), so pass null. The
          // refiner falls through to a model-generic prompt that doesn't
          // strictly need the label.
          styleLabel: null,
          modelId: result.modelUsed,
          spend: {
            workspaceId: video.workspace_id,
            projectId: video.project_id,
            featureArea: 'pipeline_variant_prompt_refinement',
          },
        });
        if (refinement.refinedCount > 0 || refinement.failedCount > 0) {
          logger.info('auto-pipeline: variant-prompt-refinement', {
            pipeline_video_id: video.id,
            refined: refinement.refinedCount,
            skipped: refinement.skippedCount,
            failed: refinement.failedCount,
          });
        }
      }
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

  // Stage 4 — advance to the new server-side image-generation stage
  // before thumbnail. The image-gen stage walks the doc, generates
  // every row's image, and re-enters itself for chunked progress
  // until all rows have image_url. When complete it advances to
  // 'generating_thumbnail'. See
  // `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
  return { kind: 'advance', nextStage: 'generating_production_doc_images' };
}

/**
 * Best-effort JSON extraction from a model response. Production cases
 * we've seen fail bare `JSON.parse`:
 *
 *   1. Output wrapped in ```json … ``` fences.
 *   2. Output wrapped in prose: "Here's the production doc: { … }
 *      Let me know if you need anything else."
 *   3. Output starts with a stray comment, ellipsis, or partial sentence
 *      before the JSON body.
 *
 * Strategy:
 *   1. Strip code fences if present.
 *   2. Try direct JSON.parse — covers the happy path with zero overhead.
 *   3. Scan for opening braces/brackets and, for each candidate, walk
 *      forward through string/escape state until the matching close.
 *      Try to JSON.parse THAT substring. First valid parse wins. Capped
 *      at the first 50 candidates so an adversarial response with
 *      thousands of `{` characters can't blow up the cron tick.
 *
 * Returns the parsed value, or null when nothing in the text parses.
 * Null is the signal the caller uses to trigger the retry path.
 *
 * Exported for unit tests. The function is pure and has no side
 * effects; it does not need access to anything in the handler's
 * closure.
 */
export function extractJson(rawText: string): unknown | null {
  if (!rawText) return null;
  let body = rawText.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  // Fast path — most responses parse directly.
  try {
    return JSON.parse(body);
  } catch {
    // fall through to the scan
  }

  const MAX_CANDIDATES = 50;
  let tried = 0;
  for (let i = 0; i < body.length && tried < MAX_CANDIDATES; i++) {
    const ch = body[i];
    if (ch !== '{' && ch !== '[') continue;
    tried++;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (c === '\\') {
          escape = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === ch) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = body.slice(i, j + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // This open-brace turned out not to be a valid JSON
            // start (e.g. it was inside JS-style {} that isn't
            // proper JSON). Bail on this candidate and let the
            // outer loop try the next open-brace.
            break;
          }
        }
      }
    }
  }
  return null;
}
