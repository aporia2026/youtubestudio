/**
 * Doodle vertical prompt builder — Phase 15.3.
 *
 * Given a Short's script + caption chunks, emits:
 *   - a BASE-SCENE PROMPT describing what the opening Doodle frame
 *     shows (composed for vertical 9:16 with subject placement in the
 *     middle-60% safe zone)
 *   - N VARIANT EDIT PROMPTS describing tiny scene changes that pair
 *     with caption-chunk transitions
 *
 * The result feeds the Doodle asset pipeline which:
 *   1. Calls Atlas Image (one t2i call) for the BASE frame
 *   2. Calls Atlas Edit (one i2i call per variant) for each variant
 *
 * Per the user's memory: animation is sibling-frame variants from the
 * base. We never ask the image model to introduce motion within a frame.
 * Each variant frame is a stand-alone still that's near-identical to
 * the base except for the described change.
 *
 * Output shape:
 *   {
 *     base_prompt: string,   // composed scene description (vertical-safe-zone aware)
 *     variants: [{
 *       caption_chunk_start_index: number,  // when this frame swaps in
 *       edit_prompt: string,                // the change from base
 *     }]
 *   }
 */

import { parseLlmJson } from './parse-llm-json';
import type { ShortCaptionChunk } from './shorts-render-types';

export interface DoodleVariantInput {
  /** The Short's spoken script. */
  shortScript: string;
  /** Optional hook line — gives the model what the first 1.5s says. */
  hook?: string;
  /** Optional payoff line — gives the model what the closing beat says. */
  payoff?: string;
  /** Pre-chunked captions. The variant count is capped at this length. */
  captions: ShortCaptionChunk[];
  /** Title or working title — gives the model the overall topic. */
  title?: string;
  /** Niche label — feeds into the style suffix. */
  niche: string;
  /** Maximum variants to ask for. Defaults to 6. Hard-capped to caption count. */
  maxVariants?: number;
}

export interface DoodleVariantSpec {
  caption_chunk_start_index: number;
  edit_prompt: string;
}

export interface DoodleVariantResult {
  base_prompt: string;
  variants: DoodleVariantSpec[];
}

const DEFAULT_MAX_VARIANTS = 6;
const ABSOLUTE_MAX_VARIANTS = 10;

/** Clamps the desired variant count to [1, min(captions.length, MAX)]. */
export function clampVariantCount(requested: number, captionCount: number): number {
  const cap = Math.min(ABSOLUTE_MAX_VARIANTS, Math.max(0, captionCount));
  if (cap === 0) return 0;
  const desired = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : DEFAULT_MAX_VARIANTS;
  return Math.max(1, Math.min(cap, desired));
}

export function buildDoodleVariantPrompt(input: DoodleVariantInput): { system: string; user: string } {
  const targetVariants = clampVariantCount(input.maxVariants ?? DEFAULT_MAX_VARIANTS, input.captions.length);
  // Show the model the chunked captions with their indices so it can
  // ground each variant's caption_chunk_start_index in the actual data.
  const captionLines = input.captions
    .map((c, i) => `[${i}] ${c.text}`)
    .join('\n');
  return {
    system: `You are an art director for a hand-drawn Doodle Explainer 2 Short — 9:16 vertical, ~30-60 seconds, voiceover-driven, near-static animation (sibling-frame variants from a single base scene; NO motion within a frame, NO labels with arrows, NO text overlays — captions are rendered separately by the player).

Given a Short's script + the pre-chunked captions, design ONE base scene + ${targetVariants} sibling variants.

**BASE SCENE (one scene, opening frame):**
- Composed for 9:16 vertical canvas. SUBJECT(S) live in the MIDDLE 60% (vertical) of the frame — top 10% and bottom 10% are reserved for YouTube UI chrome and the player's caption band.
- Anchored to the Doodle Explainer 2 visual language: stick-figure-style characters, slightly imperfect hand-drawn lines, light clothing detail, varied accent colors, white default background but can be a colored sky / real-photo backdrop / etc. NEVER textbook-style labels with arrows.
- The base scene is the WIDEST and most general scene of the whole Short — it sets the stage. Specific dramatic beats belong in the variants.
- Length: 60-180 chars.

**VARIANTS (${targetVariants} variants, each a small change from the base):**
- Each variant is a SIBLING of the base: the camera, the subjects, and the composition stay the same. ONLY ONE OR TWO elements change — a character's expression, a prop appears or disappears, a color shifts, a small new subject enters.
- Each variant is timed to a caption-chunk transition. Pick the caption-chunk index where this variant should swap in. Pick FAIRLY EVENLY spread chunk indices (don't bunch variants in the first 3 chunks).
- Each variant's edit prompt is ONE clean sentence describing the change. Examples: "The character's eyebrows raise in surprise and a yellow exclamation mark appears beside their head.", "A small red flame appears on the brown scroll the character is holding.", "The background turns from white to a soft blue sky with a single sun."
- NEVER ask for camera moves, motion blur, animation lines, or dynamic gestures — the still must read as a stand-alone Doodle Explainer frame.
- Length per variant prompt: 40-160 chars.

Output STRICTLY this JSON shape:

{
  "base_prompt": "<60-180 char base scene description>",
  "variants": [
    { "caption_chunk_start_index": <integer 0-${Math.max(0, input.captions.length - 1)}>, "edit_prompt": "<40-160 char change>" }
  ]
}

Return ONLY valid JSON.`,
    user: `Niche: ${input.niche}
${input.title ? `Working title: ${input.title}\n` : ''}${input.hook ? `Hook (first 1-3 seconds): ${input.hook}\n` : ''}${input.payoff ? `Payoff (closing line): ${input.payoff}\n` : ''}
Full script:
"""
${input.shortScript.trim().slice(0, 2400)}
"""

Pre-chunked captions (use these indices for variant placement):
${captionLines}

Design ONE base scene + ${targetVariants} sibling variants. JSON only.`,
  };
}

interface RawVariant {
  caption_chunk_start_index?: unknown;
  edit_prompt?: unknown;
}

/** Parse the LLM response. Throws if the base prompt is missing or if no
 *  variant rows survive validation. Caps each variant's chunk index at
 *  the supplied caption count so a hallucinated index can't break the
 *  renderer. */
export function parseDoodleVariantResult(
  raw: string,
  captionCount: number,
): DoodleVariantResult {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse Doodle variants JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Doodle variants response was not a JSON object.');
  }
  const r = parsed as { base_prompt?: unknown; variants?: unknown };
  const basePrompt = typeof r.base_prompt === 'string' ? r.base_prompt.trim() : '';
  if (basePrompt.length < 20) {
    throw new Error('Doodle variants response is missing a usable base_prompt.');
  }
  const rawVariants = Array.isArray(r.variants) ? r.variants : [];
  const out: DoodleVariantSpec[] = [];
  const seenIndexes = new Set<number>();
  for (const v of rawVariants) {
    if (!v || typeof v !== 'object') continue;
    const rv = v as RawVariant;
    let idx = typeof rv.caption_chunk_start_index === 'number' && Number.isFinite(rv.caption_chunk_start_index)
      ? Math.max(0, Math.round(rv.caption_chunk_start_index))
      : -1;
    if (idx < 0) continue;
    // Clamp to the actual caption count so a hallucinated index can't
    // produce a frame the renderer never reaches.
    if (captionCount > 0 && idx >= captionCount) idx = captionCount - 1;
    if (seenIndexes.has(idx)) continue; // dedupe: variants must hit distinct chunks
    const editPrompt = typeof rv.edit_prompt === 'string' ? rv.edit_prompt.trim() : '';
    if (editPrompt.length < 10) continue;
    seenIndexes.add(idx);
    out.push({ caption_chunk_start_index: idx, edit_prompt: editPrompt.slice(0, 220) });
  }
  if (out.length === 0) {
    throw new Error('Doodle variants response had no usable variants.');
  }
  // Sort by chunk index so the renderer doesn't have to.
  out.sort((a, b) => a.caption_chunk_start_index - b.caption_chunk_start_index);
  return { base_prompt: basePrompt, variants: out };
}
