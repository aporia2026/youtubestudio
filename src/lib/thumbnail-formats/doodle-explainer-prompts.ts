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

/** Sentinel value the panel sends when the user wants the LLM to pick
 *  the field from `videoContext`. Treated identically to an empty hook
 *  string by the validator + prompt builder. */
export const AUTO_FIELD_SENTINEL = 'auto';

export interface DoodleConceptInput {
  /** The user's hook phrase rendered verbatim in the image. Empty means
   *  the user opted into LLM auto-pick — the concepts call invents one
   *  from `videoContext` and returns it on `chosenBrief.hookText`. */
  hookText: string;
  /** One of `ThumbnailStyle.supported_character_expressions` (e.g. 'worried'),
   *  empty / `AUTO_FIELD_SENTINEL` for LLM auto-pick, or free-text for "Other". */
  characterExpression: string;
  /** Background scene id from `ThumbnailStyle.supported_background_scenes`,
   *  empty / `AUTO_FIELD_SENTINEL` for LLM auto-pick, or `'custom'` paired
   *  with `customBackground`. The pure helpers resolve preset ids to a
   *  prompt-hint string via the style. */
  backgroundScene: string;
  /** Used only when `backgroundScene === 'custom'`. */
  customBackground?: string;
  /** Optional context — the video's title / topic / niche / script
   *  excerpt. Helps the LLM pick subject matter aligned with the video,
   *  and is the ONLY signal it has when one of hook / expression /
   *  background is left on auto. */
  videoContext?: string;
  /** How many distinct concepts to ask the LLM for. Clamped to 1..3 at
   *  the route layer. */
  variantCount: number;
}

/** Whether a field was left unset (empty, whitespace, or the AUTO
 *  sentinel) and should be filled in by the LLM. Centralised so the
 *  validator, prompt builder, and response parser all agree on the
 *  rule. */
export function isAutoField(value: string | undefined | null): boolean {
  if (!value) return true;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === AUTO_FIELD_SENTINEL;
}

/** The LLM's picks for any field the user left on auto. Always present
 *  on a successful concepts response — fields that were user-supplied
 *  echo back the user's values so the route caller doesn't need to track
 *  which fields were auto. */
export interface ChosenBrief {
  hookText: string;
  characterExpression: string;
  /** Either a preset id from `ThumbnailStyle.supported_background_scenes`
   *  or `'custom'` when paired with `customBackground`. */
  backgroundScene: string;
  customBackground?: string;
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
 * string when nothing usable is set (unknown id, or the field was left
 * on auto and the LLM declined to fill it) — the prompt builder will
 * then omit the scene clause entirely.
 */
export function resolveBackgroundHint(input: DoodleConceptInput, style: ThumbnailStyle): string {
  if (isAutoField(input.backgroundScene)) return '';
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
 *
 * Also carries the dual contract for the brief: when the user leaves
 * hook / expression / background on auto, the LLM invents them from
 * `videoContext` and reports the picks back as `chosenBrief` so the
 * panel can echo them in the UI for the user to edit / re-roll.
 */
export function buildDoodleConceptsSystemPrompt(): string {
  return [
    'You are a senior YouTube thumbnail art director specializing in the Paint Explainer / doodle-thumbnail genre (channels like @Zenn0009).',
    '',
    'You have two jobs on every call:',
    '  A. Resolve any AUTO fields in the brief. The user may have left the hook phrase, character emotion, or background scene on "auto" — in that case YOU pick the best value, informed by the supplied video context. Echo the resolved values back on `chosenBrief`. For fields the user already supplied, echo their values back verbatim on `chosenBrief` so the caller has a single source of truth.',
    '  B. Generate the requested number of distinct concept variations for that resolved brief — different framings, different supporting props, different palettes, different label placement — all serving the same hook phrase and video topic.',
    '',
    'THE STYLE — non-negotiable visual contract:',
    '  • Hand-drawn doodle: thick uneven black ink outlines (intentional wobble), flat fills only, no shading.',
    '  • Stick-figure character with one clear emotion on the face.',
    '  • Big bold yellow comic-bold hook text with thick black outline is the focal element (~25-40% of the frame).',
    '  • Flat single-color backgrounds (white, sky-blue, brown cave, deep black space, underwater blue) — never gradients except natural phenomena.',
    '  • Optional: one red callout arrow, simple props, real photos framed in wobbly thin black rounded rectangles.',
    '',
    'AUTO-PICK RULES (when filling job A):',
    '  • hookText: 1-4 punchy words, ALL CAPS, ends in "?" or "!" when the topic carries a curiosity gap. Never a full sentence. Never paraphrases a working hook the user supplied. ≤ 60 chars.',
    '  • characterExpression: pick exactly one from the allowed list given in the user prompt — match the emotional tone of the topic (e.g. "shocked" for a reveal, "confused" for a what-if, "thinking" for a question).',
    '  • backgroundScene: pick exactly one preset id from the allowed list given in the user prompt — match the topic (e.g. a space topic → "space", a prehistory topic → "cave"). Never invent a new id, never pick "custom".',
    '',
    'CONCEPT VARIATION RULES (job B). Each variation must differ from every other on ALL THREE axes:',
    '  1. label_axis — different phrasing or placement of the hook word(s). Example: "single-word centered" vs. "two-word stacked top-left" vs. "phrase wrapped around a callout".',
    '  2. palette_axis — different background or accent colors within the style\'s allowed set. Example: "white bg + yellow hook + red arrow" vs. "sky-blue bg + yellow hook + sun accent" vs. "cave-brown bg + yellow hook + orange fire glow".',
    '  3. composition_axis — different character placement, framing, or supporting elements. Example: "character on left, hook right" vs. "character centered, hook above" vs. "split-scene comparison with arrow".',
    '',
    'A variant that shares ANY axis with a sibling is REJECTED. If you can\'t produce N truly distinct variants, ask yourself: did I just rewrite the same scene three times?',
    '',
    'OUTPUT — strict JSON, no markdown, no commentary:',
    '{',
    '  "chosenBrief": {',
    '    "hookText": "<the final hook phrase that will be rendered verbatim — your pick if user supplied AUTO, their value otherwise>",',
    '    "characterExpression": "<final emotion id from the allowed list>",',
    '    "backgroundScene": "<final preset id from the allowed list, or \'custom\' iff the user supplied a custom scene>"',
    '  },',
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
 * Carries the hook, expression, scene, video context, and variant count,
 * marking any auto fields so the LLM knows it must invent + return them
 * on `chosenBrief`. When ALL three are on auto the brief becomes
 * "design a thumbnail from this video context" — `videoContext` is then
 * the only signal the LLM has to work from.
 */
export function buildDoodleConceptsUserPrompt(input: DoodleConceptInput, style: ThumbnailStyle): string {
  const hookAuto = isAutoField(input.hookText);
  const expressionAuto = isAutoField(input.characterExpression);
  const backgroundAuto = isAutoField(input.backgroundScene);

  const allowedExpressions = style.supported_character_expressions ?? [];
  const allowedSceneIds = (style.supported_background_scenes ?? [])
    .map(s => s.id)
    .filter(id => id !== 'custom');

  const lines = [
    `Generate ${input.variantCount} distinct concept variations for a Doodle Explainer thumbnail.`,
    '',
    hookAuto
      ? 'Hook phrase: AUTO — invent a 1-4 word punchy hook from the video context below. Pick it once, list it on `chosenBrief.hookText`, and use it verbatim across all variants.'
      : `Hook phrase (render EXACTLY as supplied, never paraphrase): "${input.hookText.trim()}"`,
    expressionAuto
      ? `Character emotion: AUTO — pick exactly one of [${allowedExpressions.join(', ')}] that fits the topic. List your pick on \`chosenBrief.characterExpression\`.`
      : `Character emotion: ${input.characterExpression.trim() || 'neutral-but-interested'}`,
  ];

  if (backgroundAuto) {
    lines.push(`Background scene: AUTO — pick exactly one preset id from [${allowedSceneIds.join(', ')}] that fits the topic. List your pick on \`chosenBrief.backgroundScene\`. Then vary the per-variant palette around that scene.`);
  } else {
    const sceneHint = resolveBackgroundHint(input, style);
    lines.push(sceneHint
      ? `Background scene (use as a starting point — vary the palette per variant): ${sceneHint}`
      : 'Background scene: open — pick a flat single-color background that fits each variant');
  }

  if (input.videoContext && input.videoContext.trim()) {
    lines.push('');
    lines.push('Video context (use to pick supporting props / scene specifics, AND to resolve any AUTO fields above):');
    lines.push(input.videoContext.trim().slice(0, 1200));
  } else if (hookAuto || expressionAuto || backgroundAuto) {
    // Defensive: the validator already rejects this combination, but a
    // belt-and-braces note keeps the LLM from silently producing a
    // generic placeholder hook.
    lines.push('');
    lines.push('No video context supplied — derive AUTO fields from the non-AUTO fields you do have.');
  }

  lines.push('');
  lines.push(`Return exactly ${input.variantCount} variants AND a populated \`chosenBrief\`. Each variant must differ from every other on label_axis, palette_axis, AND composition_axis. Output strict JSON in the schema specified.`);
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
 *
 * `input` is the (post-validation) brief the route sent into the LLM —
 * the parser uses it to fall back to user-supplied values when the LLM
 * forgets to echo a non-auto field on `chosenBrief`, and to reject auto
 * fields that the LLM left empty.
 */
export type ParseConceptsResult =
  | { ok: true; variants: DoodleConcept[]; chosenBrief: ChosenBrief }
  | { ok: false; reason: string };

export function parseDoodleConceptsResponse(
  parsed: unknown,
  expectedCount: number,
  input: DoodleConceptInput,
  style: ThumbnailStyle,
): ParseConceptsResult {
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

  // Pull chosenBrief — when the LLM forgot to echo it, derive the
  // entries from `input` where the user supplied them and reject only
  // the slots that were AUTO (those genuinely need an LLM pick).
  const chosenRaw = (root.chosenBrief && typeof root.chosenBrief === 'object')
    ? root.chosenBrief as Record<string, unknown>
    : {};
  const briefResult = buildChosenBrief(chosenRaw, input, style);
  if (!briefResult.ok) return briefResult;

  return { ok: true, variants: out, chosenBrief: briefResult.brief };
}

type BuildChosenBriefResult =
  | { ok: true; brief: ChosenBrief }
  | { ok: false; reason: string };

function buildChosenBrief(
  raw: Record<string, unknown>,
  input: DoodleConceptInput,
  style: ThumbnailStyle,
): BuildChosenBriefResult {
  const rawHook = typeof raw.hookText === 'string' ? stripControl(raw.hookText) : '';
  const rawExpr = typeof raw.characterExpression === 'string' ? stripControl(raw.characterExpression) : '';
  const rawScene = typeof raw.backgroundScene === 'string' ? stripControl(raw.backgroundScene) : '';

  // Hook: prefer the LLM's pick when populated and within the length
  // cap; otherwise fall back to the user's value. If user was AUTO and
  // the LLM gave us nothing usable, that's a genuine failure.
  let hookText = rawHook;
  if (!hookText || hookText.length > HOOK_TEXT_MAX_LENGTH) {
    hookText = isAutoField(input.hookText) ? '' : input.hookText.trim();
  }
  if (!hookText) {
    return { ok: false, reason: 'chosenBrief.hookText is empty — auto-pick failed; please supply a hook phrase manually.' };
  }

  // Expression: must be a non-empty short string. When the user was on
  // auto we ALSO require the LLM's pick to be one of the style's
  // supported_character_expressions — otherwise the panel's chip picker
  // won't highlight any value after we echo it back into the form, and
  // the user sees a phantom "nothing selected" state. When the user
  // supplied a freeform expression themselves, we let it through (≤ 60
  // chars) to mirror the original route validator's freedom.
  const supportedExpressions = (style.supported_character_expressions ?? []).map(e => e.toLowerCase());
  let characterExpression = rawExpr;
  if (!characterExpression) {
    characterExpression = isAutoField(input.characterExpression) ? '' : input.characterExpression.trim();
  } else if (isAutoField(input.characterExpression)
      && supportedExpressions.length > 0
      && !supportedExpressions.includes(characterExpression.toLowerCase())) {
    // LLM ignored the allowed list — fall back to the first supported
    // value so the chip UI lights up. The user can always re-roll.
    characterExpression = supportedExpressions[0];
  }
  if (characterExpression.length > 60) characterExpression = characterExpression.slice(0, 60);
  if (!characterExpression) {
    return { ok: false, reason: 'chosenBrief.characterExpression is empty — auto-pick failed; please pick an emotion manually.' };
  }

  // Background: pin to a valid id from the style or 'custom'. If the
  // LLM picked something unknown, fall back to the user's value when
  // available, else fail.
  const validIds = new Set([
    ...(style.supported_background_scenes ?? []).map(s => s.id),
  ]);
  let backgroundScene = rawScene;
  if (!backgroundScene || !validIds.has(backgroundScene)) {
    backgroundScene = isAutoField(input.backgroundScene) ? '' : input.backgroundScene.trim();
  }
  if (!backgroundScene || (backgroundScene !== 'custom' && !validIds.has(backgroundScene))) {
    return { ok: false, reason: 'chosenBrief.backgroundScene is empty or not a valid preset id — auto-pick failed; please pick a scene manually.' };
  }
  const customBackground = backgroundScene === 'custom'
    ? (input.customBackground?.trim() || undefined)
    : undefined;

  return {
    ok: true,
    brief: { hookText, characterExpression, backgroundScene, customBackground },
  };
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
  /** Post-validation hook. May be empty when the user opted into LLM
   *  auto-pick — in that case the concepts route relies on the LLM's
   *  `chosenBrief.hookText` to fill it in for the downstream image call. */
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
 *
 * Auto-pick contract: hookText / characterExpression / backgroundScene
 * may each be empty or the `AUTO_FIELD_SENTINEL` to opt into LLM
 * auto-pick. When any field is on auto we require videoContext to be
 * non-empty — otherwise the LLM has no signal to invent from.
 */
export function validateDoodleInput(raw: unknown): ValidateInputResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'Body must be a JSON object.' };
  const obj = raw as Record<string, unknown>;
  const hookText = stripControl(typeof obj.hookText === 'string' ? obj.hookText : '');
  if (hookText.length > HOOK_TEXT_MAX_LENGTH) return { ok: false, reason: `hookText must be ≤ ${HOOK_TEXT_MAX_LENGTH} chars.` };
  if (hookText && !isAutoField(hookText) && looksLikeInjection(hookText)) {
    return { ok: false, reason: 'hookText contains a phrase that looks like a prompt-injection — please rephrase.' };
  }
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
  const anyAuto = isAutoField(hookText) || isAutoField(characterExpression) || isAutoField(backgroundScene);
  if (anyAuto && !videoContext) {
    return { ok: false, reason: 'When any of hook / emotion / background is left on auto, videoContext must be supplied so the LLM has something to invent from.' };
  }
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
   
  return s.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
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
