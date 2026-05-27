/**
 * Variant edit-prompt refiner. Rewrites the vague edit instructions
 * produced by `autoGroupVariants` (e.g. "keep the base composition
 * identical, add flap hanging") into specific visually-concrete ones
 * the GPT Image 2 Edit model can actually act on (e.g. "Show ONLY the
 * tent with a jagged vertical slit cut through one side, flap hanging
 * open. The hikers are gone. Empty slashed tent on snowy slope.").
 *
 * Why this exists: the auto-grouper's delta extraction is naive — it
 * pulls common-suffix novelty out of consecutive similar prompts
 * without semantic understanding. The Atlas Edit model then receives
 * a prompt like "add flap hanging" with no anchor for WHAT flap, WHERE,
 * HOW, so it nudges the base image imperceptibly and the variant looks
 * identical. Manual user proof (2026-05-27): a 31-word concrete
 * instruction produces a perfect variant; the auto-extracted vague one
 * produces no visible change.
 *
 * This is text-based refinement (Option A from the 2026-05-27 plan
 * pressure-test). The refiner reads the textual descriptions only —
 * base's `ai_image_prompt` + variant's `script_text` + the vague edit
 * prompt — and asks an LLM to rewrite the edit instruction. It does
 * NOT see the actual base image; for the doodle aesthetic the AI
 * output is literal enough to the prompt that vision adds 4x cost
 * for marginal accuracy. If output quality reveals visual drift we
 * upgrade to vision-based (Option B) in a follow-up.
 *
 * Runs at doc-generation time (not per variant-Generate click) so:
 *  - Refined prompts persist on the doc and are visible/editable in
 *    the editor.
 *  - One LLM call per variant, parallelised, instead of one per click.
 *  - The user sees what will be generated before clicking.
 *
 * Gated behind `USE_REFINED_VARIANT_PROMPT=1` env var; default off
 * preserves existing behavior.
 */
import { generateText } from './ai';
import { logger } from './logger';
import type { ProductionDocRowLike } from './production-doc-postprocess';

const REFINEMENT_SYSTEM_PROMPT = `You refine vague AI-image-edit instructions into specific, visually concrete ones for the GPT Image 2 Edit model.

The edit model preserves style and composition automatically — you describe ONLY what visually changes from the base frame to the variant frame.

Be specific about visual changes: which objects to add, remove, or modify; where they should appear; what they should look like. Keep it short (1–3 sentences). Do NOT re-describe the whole scene — the editor already sees the base image. Do NOT specify style or aesthetic — the editor preserves them.

Output ONLY the new edit instruction. No preamble. No surrounding quotes. No "Here's the refined instruction:" prefix.`;

export interface VariantPromptRefinement {
  /** The rows array (mutated in place — variant rows' `variant_edit_prompt`
   *  fields get rewritten with the refined version). */
  rows: ProductionDocRowLike[];
  /** Variants whose `variant_edit_prompt` was successfully rewritten. */
  refinedCount: number;
  /** Variants skipped for valid reasons: missing base, empty base prompt,
   *  empty original edit prompt, or refinement returned same/empty text. */
  skippedCount: number;
  /** Variants that hit an error during LLM refinement. The original
   *  `variant_edit_prompt` is preserved (fail-soft) — the editor falls
   *  back to whatever auto-grouper extracted. */
  failedCount: number;
}

/**
 * Walk the doc rows and refine every variant's `variant_edit_prompt`
 * using the base row's `ai_image_prompt` + the variant's `script_text`.
 * Returns counts for logging; mutates rows in place.
 *
 * Parallelises the refinement calls so doc-gen latency scales with the
 * largest group, not the sum of all variants. Each individual call is
 * fail-soft — a single LLM failure preserves that variant's existing
 * prompt without aborting the whole pass.
 */
export async function refineVariantPromptsInDoc(opts: {
  rows: ProductionDocRowLike[];
  /** Style label for context in the refinement prompt — gives the
   *  refiner a soft hint without re-specifying the aesthetic. */
  styleLabel: string | null;
  /** The doc-gen model chain's effective model id; reused for the
   *  refinement calls so no new model config / chain is required. */
  modelId: string;
  /** Spend telemetry context — workspaceId is required, projectId
   *  optional, featureArea identifies these calls in cost reports. */
  spend: { workspaceId: string; projectId?: string; featureArea: string };
}): Promise<VariantPromptRefinement> {
  const { rows, styleLabel, modelId, spend } = opts;

  // Index bases by group_id so each variant resolves its base in O(1).
  const basesByGroup = new Map<string, ProductionDocRowLike>();
  for (const row of rows) {
    const bag = row as Record<string, unknown>;
    const gid = bag.group_id;
    const vi = bag.variant_index;
    if (typeof gid === 'string' && gid && vi === 0) {
      basesByGroup.set(gid, row);
    }
  }

  let refinedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const variantRows = rows.filter((row) => {
    const bag = row as Record<string, unknown>;
    return (
      typeof bag.group_id === 'string' &&
      typeof bag.variant_index === 'number' &&
      (bag.variant_index as number) > 0 &&
      typeof bag.variant_edit_prompt === 'string' &&
      (bag.variant_edit_prompt as string).trim().length > 0
    );
  });

  if (variantRows.length === 0) {
    return { rows, refinedCount: 0, skippedCount: 0, failedCount: 0 };
  }

  await Promise.all(
    variantRows.map(async (variant) => {
      const vbag = variant as Record<string, unknown>;
      const gid = vbag.group_id as string;
      const base = basesByGroup.get(gid);
      if (!base) {
        skippedCount += 1;
        return;
      }
      const bbag = base as Record<string, unknown>;
      const basePrompt =
        typeof bbag.ai_image_prompt === 'string' ? bbag.ai_image_prompt.trim() : '';
      if (!basePrompt) {
        // Bug 3 territory — base has no scene prompt; nothing to refine
        // against. The detection pass surfaces this separately.
        skippedCount += 1;
        return;
      }
      const variantScript =
        typeof vbag.script_text === 'string' ? vbag.script_text.trim() : '';
      const originalEditPrompt = (vbag.variant_edit_prompt as string).trim();

      // Cap input lengths defensively so a pathological row doesn't
      // blow the refinement call's context budget.
      const userPrompt = [
        'Base scene (what the input image shows):',
        `"""${basePrompt.slice(0, 800)}"""`,
        '',
        'Variant beat (the next moment in the sequence):',
        `"""${variantScript.slice(0, 400)}"""`,
        '',
        'Current vague edit instruction:',
        `"""${originalEditPrompt.slice(0, 400)}"""`,
        '',
        ...(styleLabel ? [`Style: ${styleLabel}`, ''] : []),
        'Write the refined edit instruction now.',
      ].join('\n');

      try {
        const refinedRaw = await generateText({
          modelId,
          prompt: userPrompt,
          systemPrompt: REFINEMENT_SYSTEM_PROMPT,
          maxTokens: 300,
          temperature: 0.4,
          spend: { ...spend },
        });
        // Strip surrounding quotes if the model wrapped its output despite
        // the system-prompt instruction not to.
        const refined = refinedRaw
          .trim()
          .replace(/^["'`]+|["'`]+$/g, '')
          .trim();
        if (refined && refined !== originalEditPrompt) {
          vbag.variant_edit_prompt = refined;
          refinedCount += 1;
        } else {
          skippedCount += 1;
        }
      } catch (err) {
        logger.warn('[variant-prompt-refiner] refinement failed for variant', {
          group_id: gid,
          variant_index: vbag.variant_index,
          original_chars: originalEditPrompt.length,
          error: err instanceof Error ? err.message : String(err),
        });
        failedCount += 1;
      }
    }),
  );

  return { rows, refinedCount, skippedCount, failedCount };
}
