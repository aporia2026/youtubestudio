/**
 * Pure prompt-builder helpers for the Doodle Explainer thumbnail format.
 *
 * The format works in two LLM-free + one LLM-driven phase:
 *   1. (LLM) Generate N distinct concept variations that each differ on
 *      label phrasing, palette, AND composition (per user spec Q3).
 *   2. (Pure) Combine each concept with the style's bake-in suffix +
 *      the hook + the expression + the scene to produce a final image-gen
 *      prompt per variant.
 *   3. (No LLM) Fan out to the image model in parallel.
 *
 * Everything here is pure + sync so the route, the panel, and tests can
 * all call it without spinning up a model. The route layer adds
 * rate-limit / validation / spend tracking / SSRF guard.
 *
 * Plan: _plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md.
 */

import type { ThumbnailStyle } from '@/lib/thumbnail-styles';

export interface DoodleConceptInput {
  /** The user's hook phrase rendered verbatim in the image. Required. */
  hookText: string;
  /** One of `ThumbnailStyle.supported_character_expressions` (e.g. 'worried').
   *  Free-text accepted for "Other". */
  characterExpression: string;
  /** Background scene id from `ThumbnailStyle.supported_background_scenes`.
   *  The pure helpers resolve this to a prompt-hint string via the style. */
  backgroundScene: string;
  /** Used only when `backgroundScene === 'custom'`. */
  customBackground?: string;
  /** Optional context — the video's title / topic / niche / script
   *  excerpt. Helps the LLM pick subject matter aligned with the video. */
  videoContext?: string;
  /** How many distinct concepts to ask the LLM for. Clamped to 1..3 at
   *  the route layer. */
  variantCount: number;
}

export interface DoodleConcept {
  /** Human-readable label shown under the variant in the picker. */
  conceptLabel: string;
  /** Composition hint that varies between variants (e.g.
   *  "character on left, hook text on right, banana peel prop"). The
   *  full image prompt is built from this + the style suffix +
   *  invariant hook/expression/scene parameters in
   *  `buildDoodleImagePrompt`. */
  compositionHint: string;
  /** Structured record of what this variant changes vs. siblings — the
   *  Q3 contract requires variants to differ on all three axes. The
   *  panel surfaces these in the picker for transparency; the schema
   *  validator below rejects responses that leave them empty. */
  variation_axes: {
    label_axis: string;
    palette_axis: string;
    composition_axis: string;
  };
}

/**
 * Resolves a background-scene id to the style's prompt hint, falling
 * back to the user's custom text when the id is 'custom'. Returns empty
 * string when nothing usable is set — the prompt builder will then omit
 * the scene clause entirely.
 */
export function resolveBackgroundHint(input: DoodleConceptInput, style: ThumbnailStyle): string {
  if (input.backgroundScene === 'custom') {
    return (input.customBackground || '').trim();
  }
  const scene = style.supported_background_scenes?.find(s => s.id === input.backgroundScene);
  return scene?.promptHint || '';
}

/**
 * Builds the system prompt for the concepts-generating LLM call. Tells
 * the model what the Doodle Explainer style is, what a valid response
 * looks like, and — critically — that variants MUST differ on all three
 * axes (label phrasing, palette, composition). Without the explicit
 * "all three" rule, LLMs tend to produce three captions of the same
 * scene and call it a day, defeating the variant picker's purpose.
 */
export function buildDoodleConceptsSystemPrompt(): string {
  return [
    'You are a senior YouTube thumbnail art director specializing in the Paint Explainer / doodle-thumbnail genre (channels like @Zenn0009).',
    '',
    'You generate distinct CONCEPT VARIATIONS for a single thumbnail brief. Each variation is a different creative take — different framings, different supporting props, different palettes, different label placement — that all serve the same hook phrase and video topic.',
    '',
    'THE STYLE — non-negotiable visual contract:',
    '  • Hand-drawn doodle: thick uneven black ink outlines (intentional wobble), flat fills only, no shading.',
    '  • Stick-figure character with one clear emotion on the face.',
    '  • Big bold yellow comic-bold hook text with thick black outline is the focal element (~25-40% of the frame).',
    '  • Flat single-color backgrounds (white, sky-blue, brown cave, deep black space, underwater blue) — never gradients except natural phenomena.',
    '  • Optional: one red callout arrow, simple props, real photos framed in wobbly thin black rounded rectangles.',
    '',
    'YOUR JOB — generate the requested number of CONCEPT VARIATIONS. Each variation must differ from every other on ALL THREE axes:',
    '  1. label_axis — different phrasing or placement of the hook word(s). Example: "single-word centered" vs. "two-word stacked top-left" vs. "phrase wrapped around a callout".',
    '  2. palette_axis — different background or accent colors within the style\'s allowed set. Example: "white bg + yellow hook + red arrow" vs. "sky-blue bg + yellow hook + sun accent" vs. "cave-brown bg + yellow hook + orange fire glow".',
    '  3. composition_axis — different character placement, framing, or supporting elements. Example: "character on left, hook right" vs. "character centered, hook above" vs. "split-scene comparison with arrow".',
    '',
    'A variant that shares ANY axis with a sibling is REJECTED. If you can\'t produce N truly distinct variants, ask yourself: did I just rewrite the same scene three times?',
    '',
    'OUTPUT — strict JSON, no markdown, no commentary:',
    '{',
    '  "variants": [',
    '    {',
    '      "conceptLabel": "<short human label, e.g. \'Character left, banana peel at feet\'>",',
    '      "compositionHint": "<full detailed scene description for the image model: character pose, position, props, background color, hook placement>",',
    '      "variation_axes": {',
    '        "label_axis": "<one line: what about the label is different from siblings>",',
    '        "palette_axis": "<one line: what about the palette is different from siblings>",',
    '        "composition_axis": "<one line: what about the composition is different from siblings>"',
    '      }',
    '    }',
    '    /* ...N total variants... */',
    '  ]',
    '}',
  ].join('\n');
}

/**
 * Builds the user-side prompt for the concepts-generating LLM call.
 * Carries the hook, expression, scene, video context, and variant count.
 */
export function buildDoodleConceptsUserPrompt(input: DoodleConceptInput, style: ThumbnailStyle): string {
  const sceneHint = resolveBackgroundHint(input, style);
  const lines = [
    `Generate ${input.variantCount} distinct concept variations for a Doodle Explainer thumbnail.`,
    '',
    `Hook phrase (render EXACTLY as supplied, never paraphrase): "${input.hookText.trim()}"`,
    `Character emotion: ${input.characterExpression.trim() || 'neutral-but-interested'}`,
    sceneHint ? `Background scene (use as a starting point — vary the palette per variant): ${sceneHint}` : 'Background scene: open — pick a flat single-color background that fits each variant',
  ];
  if (input.videoContext && input.videoContext.trim()) {
    lines.push('');
    lines.push('Video context (use to pick supporting props / scene specifics, but the HOOK is the focal element):');
    lines.push(input.videoContext.trim().slice(0, 1200));
  }
  lines.push('');
  lines.push(`Return exactly ${input.variantCount} variants. Each must differ from every other on label_axis, palette_axis, AND composition_axis. Output strict JSON in the schema specified.`);
  return lines.join('\n');
}

/**
 * Combines a concept (from the LLM) with the invariant hook + expression
 * + scene + the style's full visual suffix into the final image-gen
 * prompt. Pure + sync.
 *
 * Centralised so prompts stay consistent across the route, the
 * "regenerate this slot" path (which re-uses the same concept), and any
 * future i2i fallback path. The structure deliberately puts the
 * variant-specific composition hint BEFORE the style suffix so the
 * model treats the per-variant instructions as primary and the style as
 * the rendering contract.
 */
export function buildDoodleImagePrompt(input: {
  hookText: string;
  characterExpression: string;
  backgroundHint: string;
  concept: Pick<DoodleConcept, 'compositionHint'>;
  styleSuffix: string;
}): string {
  const { hookText, characterExpression, backgroundHint, concept, styleSuffix } = input;
  const safeHook = hookText.trim();
  const safeExpression = characterExpression.trim() || 'expressive';
  const bg = backgroundHint.trim();
  const composition = concept.compositionHint.trim();

  const parts: string[] = [];
  parts.push(`A 16:9 YouTube thumbnail in the Paint Explainer doodle style.`);
  parts.push(`Hook phrase rendered verbatim in big bold yellow comic-bold typography with thick black outline: "${safeHook}".`);
  parts.push(`Character expression: ${safeExpression}.`);
  if (bg) parts.push(`Background: ${bg}.`);
  parts.push(`Composition for this variant: ${composition}.`);
  parts.push(styleSuffix.trim());
  return parts.join(' ');
}

/**
 * Strict shape validator for the LLM's JSON. Returns a discriminated
 * result so the route can either succeed cleanly or surface a precise
 * "what was malformed" error to the client (useful for telemetry +
 * for prompt-iteration debugging).
 */
export type ParseConceptsResult =
  | { ok: true; variants: DoodleConcept[] }
  | { ok: false; reason: string };

export function parseDoodleConceptsResponse(parsed: unknown, expectedCount: number): ParseConceptsResult {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Response was not a JSON object.' };
  }
  const root = parsed as Record<string, unknown>;
  const variants = root.variants;
  if (!Array.isArray(variants)) {
    return { ok: false, reason: 'Missing or non-array "variants" field.' };
  }
  if (variants.length !== expectedCount) {
    return { ok: false, reason: `Expected exactly ${expectedCount} variants, received ${variants.length}.` };
  }
  const out: DoodleConcept[] = [];
  for (let i = 0; i < variants.length; i += 1) {
    const v = variants[i];
    if (!v || typeof v !== 'object') {
      return { ok: false, reason: `variants[${i}] is not an object.` };
    }
    const row = v as Record<string, unknown>;
    const conceptLabel = typeof row.conceptLabel === 'string' ? row.conceptLabel.trim() : '';
    const compositionHint = typeof row.compositionHint === 'string' ? row.compositionHint.trim() : '';
    if (!conceptLabel) return { ok: false, reason: `variants[${i}].conceptLabel is empty.` };
    if (!compositionHint) return { ok: false, reason: `variants[${i}].compositionHint is empty.` };
    const axes = row.variation_axes;
    if (!axes || typeof axes !== 'object') {
      return { ok: false, reason: `variants[${i}].variation_axes is missing.` };
    }
    const axesRow = axes as Record<string, unknown>;
    const label_axis = typeof axesRow.label_axis === 'string' ? axesRow.label_axis.trim() : '';
    const palette_axis = typeof axesRow.palette_axis === 'string' ? axesRow.palette_axis.trim() : '';
    const composition_axis = typeof axesRow.composition_axis === 'string' ? axesRow.composition_axis.trim() : '';
    if (!label_axis) return { ok: false, reason: `variants[${i}].variation_axes.label_axis is empty.` };
    if (!palette_axis) return { ok: false, reason: `variants[${i}].variation_axes.palette_axis is empty.` };
    if (!composition_axis) return { ok: false, reason: `variants[${i}].variation_axes.composition_axis is empty.` };
    out.push({
      conceptLabel,
      compositionHint,
      variation_axes: { label_axis, palette_axis, composition_axis },
    });
  }
  // Cross-variant distinctness check — the LLM sometimes produces three
  // variants with identical axes despite the system prompt. Reject so
  // the route can either retry with a higher temperature OR surface a
  // clean error.
  if (out.length >= 2) {
    const labelAxes = new Set(out.map(v => v.variation_axes.label_axis.toLowerCase()));
    const paletteAxes = new Set(out.map(v => v.variation_axes.palette_axis.toLowerCase()));
    const compAxes = new Set(out.map(v => v.variation_axes.composition_axis.toLowerCase()));
    if (labelAxes.size < out.length) return { ok: false, reason: 'Two or more variants share the same label_axis — variants must differ.' };
    if (paletteAxes.size < out.length) return { ok: false, reason: 'Two or more variants share the same palette_axis — variants must differ.' };
    if (compAxes.size < out.length) return { ok: false, reason: 'Two or more variants share the same composition_axis — variants must differ.' };
  }
  return { ok: true, variants: out };
}

/**
 * Hard caps on user-controlled string lengths fed to the LLM /
 * downstream image model. Defence against prompt-injection and against
 * accidental cost blow-ups from a paste-the-whole-script input.
 */
export const HOOK_TEXT_MAX_LENGTH = 60;
export const CUSTOM_BACKGROUND_MAX_LENGTH = 200;
export const VIDEO_CONTEXT_MAX_LENGTH = 2000;

export interface ValidatedDoodleInput extends DoodleConceptInput {
  /** Always populated post-validation; the route reads from this. */
  hookText: string;
}

export type ValidateInputResult =
  | { ok: true; value: ValidatedDoodleInput }
  | { ok: false; reason: string };

/**
 * Sanitises user input. Strips control characters, enforces length
 * caps, and rejects obvious prompt-injection patterns ("ignore previous
 * instructions" etc.) on free-text fields. The caller is the route,
 * which converts a rejection into a 400.
 */
export function validateDoodleInput(raw: unknown): ValidateInputResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'Body must be a JSON object.' };
  const obj = raw as Record<string, unknown>;
  const hookText = stripControl(typeof obj.hookText === 'string' ? obj.hookText : '');
  if (!hookText) return { ok: false, reason: 'hookText is required (the bold yellow phrase to render).' };
  if (hookText.length > HOOK_TEXT_MAX_LENGTH) return { ok: false, reason: `hookText must be ≤ ${HOOK_TEXT_MAX_LENGTH} chars.` };
  if (looksLikeInjection(hookText)) return { ok: false, reason: 'hookText contains a phrase that looks like a prompt-injection — please rephrase.' };
  const characterExpression = stripControl(typeof obj.characterExpression === 'string' ? obj.characterExpression : '');
  if (characterExpression.length > 60) return { ok: false, reason: 'characterExpression must be ≤ 60 chars.' };
  const backgroundScene = stripControl(typeof obj.backgroundScene === 'string' ? obj.backgroundScene : '');
  if (backgroundScene.length > 80) return { ok: false, reason: 'backgroundScene must be ≤ 80 chars.' };
  const customBackground = stripControl(typeof obj.customBackground === 'string' ? obj.customBackground : '');
  if (customBackground.length > CUSTOM_BACKGROUND_MAX_LENGTH) return { ok: false, reason: `customBackground must be ≤ ${CUSTOM_BACKGROUND_MAX_LENGTH} chars.` };
  if (customBackground && looksLikeInjection(customBackground)) return { ok: false, reason: 'customBackground contains a phrase that looks like a prompt-injection — please rephrase.' };
  const videoContext = stripControl(typeof obj.videoContext === 'string' ? obj.videoContext : '').slice(0, VIDEO_CONTEXT_MAX_LENGTH);
  const variantCount = typeof obj.variantCount === 'number' && Number.isFinite(obj.variantCount)
    ? Math.max(1, Math.min(3, Math.floor(obj.variantCount)))
    : 3;
  return {
    ok: true,
    value: {
      hookText,
      characterExpression,
      backgroundScene,
      customBackground: customBackground || undefined,
      videoContext: videoContext || undefined,
      variantCount,
    },
  };
}

function stripControl(s: string): string {
   
  return s.replace(/[ -]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function looksLikeInjection(s: string): boolean {
  const lower = s.toLowerCase();
  // Conservative list — the goal is to catch obvious "ignore previous"
  // attacks without false-positiving on legitimate creative hooks.
  const flagged = [
    'ignore previous',
    'ignore the previous',
    'disregard the above',
    'forget previous',
    'system prompt:',
    'system:',
    'you are now',
    'new instructions:',
  ];
  return flagged.some(s => lower.includes(s));
}
