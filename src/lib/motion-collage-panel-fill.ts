/**
 * Auto-fill the per-panel keyframe prompts for a `doodle_explainer_2`
 * motion_collage row.
 *
 * The main doc-generation LLM already knows how to emit
 * `motion_collage_panel_prompts` (see the MOTION COLLAGE section of
 * `production-doc-styles.ts`), but the manual "↯ Convert to motion
 * collage" button and the editor's grid picker leave the panels empty —
 * which makes the feature useless as a manual action (the user would
 * have to hand-type every keyframe). This module gives those manual
 * paths the same keyframe-decomposition intelligence without re-running
 * the whole doc: it builds the LLM prompt that splits ONE narration beat
 * into N consecutive keyframes, and parses the response back into an
 * N-length string array.
 *
 * Pure + provider-agnostic so it's unit-testable. The API route at
 * `src/app/api/generate/production-doc/motion-collage/panels/route.ts`
 * wraps `buildPanelFillPrompt` with auth + a `generateText` call and
 * runs the output through `parsePanelFillResponse`.
 *
 * The per-panel rules below are deliberately a tight distillation of the
 * style guide's MOTION COLLAGE section — same-scene constraint,
 * subject-first framing, 80-150 char target, sparse doodle density — so
 * the auto-filled prompts match what `generateMotionCollage` expects.
 *
 * See `_plans/2026-06-01-motion-collage-panel-autofill.md`.
 */
import { parseLlmJson } from './parse-llm-json';
import { buildCharacterBibleBlock } from './motion-collage-prompt';

export interface BuildPanelFillPromptArgs {
  /** The row's narration beat — the motion this collage has to depict. */
  scriptText: string;
  /** The row's visual_description, if any. Adds scene context. */
  visualDescription?: string;
  /** The row's pre-existing ai_image_prompt, if any. On a converted row
   *  this is the prompt that was wiped by the convert handler; the
   *  caller passes the captured value so the scene anchor survives. */
  baseImagePrompt?: string;
  cols: number;
  rows: number;
  /** Existing panel prompts (length should be cols×rows). Non-empty
   *  entries are PRESERVED — the model is told to keep them verbatim and
   *  write only the blank slots, so new frames pace correctly between the
   *  ones the user already wrote. The route + client also merge
   *  defensively so a model that ignores this can't clobber edits. */
  existingPanels?: readonly string[];
  /** The resolved style's ai_image_suffix — doodle vocabulary the panels
   *  inherit. Mentioned in the prompt so the model doesn't restate it. */
  styleSuffix?: string;
  /** Doc-level character bible. Same shape as
   *  `ProductionDoc.doodle_explainer_2_character_descriptions`. */
  characterDescriptions?: Record<string, string>;
}

export interface PanelFillPrompt {
  system: string;
  user: string;
  /** Number of panels expected back (cols×rows). */
  expected: number;
}

/** Short corner annotation for the four corners of a grid; empty for
 *  interior cells. Mirrors the labels the editor + composer use so the
 *  model reasons about position consistently across the system. */
function cornerLabel(i: number, cols: number, rows: number): string {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const isTop = row === 0;
  const isBottom = row === rows - 1;
  const isLeft = col === 0;
  const isRight = col === cols - 1;
  if (isTop && isLeft) return ' (top-left)';
  if (isTop && isRight) return ' (top-right)';
  if (isBottom && isLeft) return ' (bottom-left)';
  if (isBottom && isRight) return ' (bottom-right)';
  return '';
}

export function buildPanelFillPrompt(args: BuildPanelFillPromptArgs): PanelFillPrompt {
  const {
    scriptText,
    visualDescription,
    baseImagePrompt,
    cols,
    rows,
    existingPanels,
    styleSuffix,
    characterDescriptions,
  } = args;
  const expected = cols * rows;

  const system = [
    'You decompose ONE narration beat of a hand-drawn doodle explainer video into a',
    `${cols}×${rows} grid of ${expected} consecutive keyframes that, played in sequence, read as ONE continuous motion.`,
    '',
    'THE ONE RULE THAT MATTERS: every panel is the SAME scene — identical composition, camera angle, character, background, lighting, and props. ONLY the moving element advances frame by frame. You are NOT writing 4 different shots; you are writing 4 freeze-frames of a single motion.',
    '',
    'FRAMING IS LOCKED: never describe a zoom, close-up, pan, tilt, dolly, or any camera move. Every subject stays at the EXACT same size and position across all panels — if the character is fully visible (head to feet) in panel 1, they must be fully visible at the same coordinates in every other panel. Do not write "zoom in", "close-up", "low angle", "wide shot", or any framing keyword in later panels.',
    '',
    'PER-PANEL PROMPT RULES:',
    '  - KEEP EACH PANEL SHORT: 80-150 characters. Longer prompts push the image model toward dense, detail-filled output that breaks the sparse doodle look.',
    '  - SUBJECT-FIRST: start with the moving subject and its STATE at THIS frame, not the wide setting. Describe the position/pose the element has reached, not the action itself.',
    '  - Panel 1 establishes the scene + the starting state. Each later panel says "Same scene" (or "same wide shot, same <anchors>") then states only what advanced.',
    '  - Spread the motion EVENLY across the panels so the arc is smooth from first to last.',
    '  - Sparse doodle aesthetic: plain white background, simple silhouettes, generous empty space. Do NOT fill the frame edge to edge.',
    '',
    'GOOD (87 chars): "Stick figure runner mid-stride, right foot lifting from the brown ground. Same scene."',
    'BAD (210 chars): "Wide harbor view of the entire dock with several ships in the distance, blue water spreading to the horizon, a clear sky above, and a stick figure runner mid-stride near the foreground. Same scene as before."',
    '',
    styleSuffix
      ? 'A global doodle STYLE suffix is appended downstream — do NOT restate style/medium words ("hand-drawn", "doodle", "white background") in every panel; describe the scene and motion only.'
      : '',
    '',
    `OUTPUT: a JSON array of EXACTLY ${expected} strings, in reading order (index 0 = top-left, last = bottom-right). No prose, no markdown, no keys — just the array.`,
  ].filter(Boolean).join('\n');

  const bible = buildCharacterBibleBlock(characterDescriptions);

  // Existing-panel context: list every slot, marking filled ones to KEEP
  // verbatim and blank ones to WRITE. When all slots are blank (the
  // convert / fresh case) we skip this block entirely so the model just
  // writes all N.
  const hasExisting = (existingPanels ?? []).some((p) => p?.trim());
  const existingBlock = hasExisting
    ? [
        'EXISTING PANELS — keep the filled ones EXACTLY as written and return them unchanged at their index; write ONLY the slots marked [WRITE THIS]:',
        ...Array.from({ length: expected }, (_, i) => {
          const cur = (existingPanels?.[i] ?? '').trim();
          const label = `Panel ${i + 1}${cornerLabel(i, cols, rows)}`;
          return cur ? `  ${label}: ${cur}` : `  ${label}: [WRITE THIS]`;
        }),
      ].join('\n')
    : '';

  const sceneAnchor = [
    `NARRATION BEAT (the motion to depict): ${scriptText.trim() || '(none given)'}`,
    visualDescription?.trim() ? `VISUAL DESCRIPTION: ${visualDescription.trim()}` : '',
    baseImagePrompt?.trim() ? `SCENE / IMAGE PROMPT FOR THIS BEAT: ${baseImagePrompt.trim()}` : '',
  ].filter(Boolean).join('\n');

  const user = [
    bible,
    sceneAnchor,
    existingBlock,
    `Write the ${cols}×${rows} grid (${expected} keyframes) now as a JSON array of ${expected} strings.`,
  ].filter(Boolean).join('\n\n');

  return { system, user, expected };
}

/**
 * Parse the model's response into exactly `expected` panel strings.
 *
 * Reuses `parseLlmJson` (handles ```json fences + bare arrays). Coerces
 * each element to a trimmed string (non-strings become ''), then pads
 * (with '') or truncates to `expected` so the caller always gets a
 * fixed-length array matching the grid. Index alignment is PRESERVED —
 * we never compact out interior blanks, because panel position is
 * meaningful (index 0 = top-left … last = bottom-right). Throws only
 * when no JSON array can be extracted at all — the caller toasts that.
 */
export function parsePanelFillResponse(raw: string, expected: number): string[] {
  const parsed = parseLlmJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of panel prompts');
  }
  // Pad short / truncate long so the result always matches the grid,
  // keeping each element at its original index.
  return Array.from({ length: expected }, (_, i) => {
    const v = parsed[i];
    return typeof v === 'string' ? v.trim() : '';
  });
}
