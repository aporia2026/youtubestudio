/**
 * Transparent-prop image generation for paint_explainer_v1's
 * `<PropSlideIn>` motion beats.
 *
 * Given a free-text `propPromptHint` from the LLM (e.g. "a wooden
 * barrel", "a Polaroid SX-70 camera", "a rolled-up parchment scroll"),
 * generate a single isolated prop PNG on plain white background. The
 * renderer composites it onto the doodle canvas via `objectFit:
 * contain`, so the white background blends seamlessly with the white
 * doodle canvas — no RMBG step required for the MVP. A future
 * polish-pass could add background removal to get true transparency
 * on multi-color compositions.
 *
 * Model: Atlas GPT Image 2 T2I — same provider as the rest of the
 * image-gen surface (atlas-cloud-images.ts). Cost ~$0.04 per call,
 * deduplicated by the caller's per-doc cache so each unique prop
 * pays for one generation regardless of how many beats reference it.
 *
 * Pure: no IO outside the Atlas T2I call, no state. The caller is
 * responsible for:
 *   1. Checking the cache before calling (avoid duplicate spend).
 *   2. Storing the URL into the cache after a successful call.
 *   3. Emitting the row-tagged cost-telemetry log line.
 *
 * Plan: §4 + §10 + §15 PR 5 of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */
import { generateAtlasT2I } from './atlas-cloud-images';

/** Cost per Atlas T2I call. Carried in the result so the caller's
 *  cost telemetry attribute it correctly. */
const PROP_GENERATION_COST_USD = 0.04;

/** Tight prompt envelope around the LLM's free-text `propPromptHint`.
 *  The directives keep the output isolated (no background prop bleed
 *  from training data), centered (so the renderer's contain-fit
 *  positions consistently), and styled-correct (Paint Explainer
 *  doodle, not photoreal or vector-clean).
 *
 *  Exported for unit testing — the prompt is load-bearing for prop
 *  quality, and silent edits could degrade every prop_slide render
 *  without leaving a trace. */
export const PROP_PROMPT_PREFIX = 'A single hand-drawn doodle of ';
export const PROP_PROMPT_SUFFIX =
  ' on a pure white background. ' +
  'Thick uneven black ink outlines in the Paint Explainer style — wobbly, not vector-clean. ' +
  'Flat fills only, sparse saturated color where the object naturally has color. ' +
  'Centered in the frame, fills about 70% of the canvas, plenty of negative space around. ' +
  'Show ONLY the named object: no character, no hands, no scene, no text, no labels, no shadow. ' +
  'Pure white background everywhere outside the object outline.';

/** Result envelope returned by a successful prop generation. */
export interface PropGenerationSuccess {
  url: string;
  predictionId: string;
  costUsd: number;
  durationMs: number;
}

/** Result envelope returned on any failure (Atlas error, network
 *  flake, validation). Never throws. */
export interface PropGenerationFailure {
  error: string;
  costUsd: 0;
  durationMs: number;
}

export type PropGenerationResult = PropGenerationSuccess | PropGenerationFailure;

/** Build the full Atlas T2I prompt for a prop hint. Pure / exported
 *  for unit testing — the assembly is straightforward but the LLM
 *  output quality depends on it being stable. */
export function buildPropPrompt(promptHint: string): string {
  const trimmed = promptHint.trim();
  // Strip a trailing period from the hint so the suffix doesn't
  // produce a double-period at the boundary.
  const noTrailingDot = trimmed.replace(/\.+$/, '');
  return `${PROP_PROMPT_PREFIX}${noTrailingDot}${PROP_PROMPT_SUFFIX}`;
}

/**
 * Generate the prop PNG for a single `propPromptHint`. Returns the
 * Atlas CDN URL on success; the caller is responsible for mirroring
 * to R2 if it needs to persist past the vendor TTL.
 *
 * Square 1024×1024 output — props are typically isolated objects
 * that compose well at square aspect, and the renderer's contain-fit
 * handles any aspect mismatch. The doc-level cost cap pre-check
 * uses $0.04/call (the figure exported from this module) to
 * estimate per-doc prop spend.
 *
 * Never throws — input-validation and Atlas failures both return a
 * structured failure object so the caller can skip the beat without
 * unwinding the stage.
 */
export async function generatePropImage(args: {
  promptHint: string;
}): Promise<PropGenerationResult> {
  const t0 = Date.now();
  const trimmed = args.promptHint.trim();
  if (trimmed.length === 0) {
    return {
      error: 'empty_prompt_hint',
      costUsd: 0,
      durationMs: Date.now() - t0,
    };
  }

  const prompt = buildPropPrompt(trimmed);

  console.info('[prop-generation start]', {
    prompt_hint_head: trimmed.slice(0, 60),
    prompt_chars: prompt.length,
  });

  try {
    const result = await generateAtlasT2I({
      prompt,
      size: '1024x1024',
      quality: 'medium',
    });
    console.info('[prop-generation done]', {
      prompt_hint_head: trimmed.slice(0, 60),
      prediction_id: result.predictionId,
      predict_ms: result.predictTimeMs,
      cost_usd: PROP_GENERATION_COST_USD,
    });
    return {
      url: result.url,
      predictionId: result.predictionId,
      costUsd: PROP_GENERATION_COST_USD,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[prop-generation error]', {
      prompt_hint_head: trimmed.slice(0, 60),
      detail: detail.slice(0, 240),
    });
    return {
      error: detail.slice(0, 240),
      costUsd: 0,
      durationMs: Date.now() - t0,
    };
  }
}
