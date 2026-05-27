/**
 * Per-cell prompt augmentation shared between the single-shot image
 * route and the collage route.
 *
 * Both surfaces need to apply the same OST / safe-top / sheet-description
 * directives to a raw cell prompt before handing it to the image model.
 * Keeping the logic in one module guarantees behaviour parity — when a
 * user enables collage mode, the per-cell prompts that reach Kie/Atlas
 * are byte-identical to what the single-shot path would have sent for
 * the same cell metadata.
 *
 * History: the augmentation block lived inline in
 * `src/app/api/generate/production-doc/image/route.ts` (lines ~109–188
 * before the extraction). It was duplicated into the collage path as
 * part of the 2026-05-26 plan that flipped `collage_mode` ON by default.
 * The original block had no augmentation in the collage route, which
 * meant bulk-gen via collage silently regressed OST baking and safe-top
 * composition. See `_plans/2026-05-26-collage-default-on-with-per-cell-augmentation.md`.
 */
import { logger } from './logger';

/** Total char cap for the single-shot route's augmented prompt. */
export const SINGLE_SHOT_PROMPT_CAP = 2000;

/** Total char cap for a single collage cell's augmented prompt. With a
 *  ~250-char collage template and 4 cells, the composed prompt lands at
 *  ~2650 chars — well within Kie request body limits. */
export const COLLAGE_CELL_PROMPT_CAP = 600;

export interface AugmentCellPromptInput {
  /** Raw scene description (already includes any upstream style suffix). */
  prompt: string;
  /** Per-cell on-screen text. Sanitised + capped at 120 chars. */
  onScreenText?: string;
  /** How the OST renders. `'bake'` injects the text into the diffusion
   *  prompt; `'overlay'` / `'none'` keep the underlying image clean and
   *  let Remotion's LowerThird composite at render time. Defaults to
   *  `'bake'` to match the single-shot route's historical posture. */
  onScreenTextMode?: 'bake' | 'overlay' | 'none';
  /** When non-empty, the row will render a section-title stripe at
   *  render time. Used to decide whether to bias the scene with the
   *  safe-top directive. */
  sectionTitle?: string;
  /** How the stripe interacts with the image. `'overlay'` means the
   *  stripe sits on top of the image (image needs empty upper region);
   *  `'letterbox'` shrinks the canvas so the stripe sits beside the
   *  image (no scene bias needed). Defaults to `'letterbox'`. */
  sectionTitleLayout?: 'overlay' | 'letterbox';
  /** Doc-level style-sheet description appended at the tail as a
   *  continuity hint. Sanitised + capped at 240 chars. */
  styleSheetDescription?: string;
  /** Hard ceiling on the returned `prompt` length. Single-shot:
   *  {@link SINGLE_SHOT_PROMPT_CAP}. Collage cell:
   *  {@link COLLAGE_CELL_PROMPT_CAP}. */
  promptCap: number;
  /** Source tag for telemetry. Helps disambiguate which surface fired
   *  the truncation log line. Optional. */
  source?: string;
}

export interface AugmentCellPromptResult {
  /** Final augmented prompt to send to the model. */
  prompt: string;
  /** True when the user-supplied body had to be trimmed to fit
   *  `promptCap` after accounting for the augmentation overhead. */
  truncated: boolean;
  /** Length of the user-supplied body before truncation. */
  originalBodyLen: number;
  /** Length of the user-supplied body after truncation. */
  finalBodyLen: number;
  /** Sum of all directive lengths (safe-top + OST leading + OST trailing
   *  + sheet desc). The user-body budget is `promptCap - fixedOverhead
   *  - 4` (the 4-char slack matches the single-shot route's
   *  long-standing margin). */
  fixedOverhead: number;
  /** Budget the user body was actually allowed to use. */
  promptBudget: number;
  /** True when the OST leading + trailing directives were appended. */
  ostBaked: boolean;
  /** True when the safe-top scene bias directive was prepended. */
  safeTop: boolean;
  /** True when the sheet-description tail directive was appended. */
  sheetDesc: boolean;
}

/**
 * Apply per-cell augmentation to a raw prompt and return the final
 * string ready for the image model. Byte-identical output to the
 * historical inline block when called with the same inputs and
 * `promptCap = SINGLE_SHOT_PROMPT_CAP`.
 *
 * Directive ordering (preserved from the inline block):
 *   `${safeTop}${ostLeading}${body}${ostTrailing}${sheetDesc}`
 *
 * Image models weight late tokens heavily for "what must appear in
 * the image", so the OST trailing directive intentionally sits after
 * the body. Sheet description follows it — the visual-continuity hint
 * is the lowest-priority signal in the prompt.
 */
export function augmentCellPrompt(input: AugmentCellPromptInput): AugmentCellPromptResult {
  // Normalise the OST mode and layout exactly like the single-shot
  // route does. Defaults must match: 'bake' for mode, 'letterbox' for
  // layout. Changing these defaults would silently regress behaviour
  // for callers that omit the fields.
  const normalizedLayout: 'overlay' | 'letterbox' =
    input.sectionTitleLayout === 'overlay' || input.sectionTitleLayout === 'letterbox'
      ? input.sectionTitleLayout
      : 'letterbox';
  const normalizedOstMode: 'bake' | 'overlay' | 'none' =
    input.onScreenTextMode === 'bake' || input.onScreenTextMode === 'overlay' || input.onScreenTextMode === 'none'
      ? input.onScreenTextMode
      : 'bake';

  // Safe-top scene bias — only useful when the stripe will overlay the
  // image (covering its top). When the stripe is letterboxed, the
  // generation already targets a shrunken canvas, so biasing the prompt
  // is redundant and only crowds the input.
  const hasSectionStripe = Boolean(input.sectionTitle?.trim());
  const needsSafeTopBias = hasSectionStripe && normalizedLayout === 'overlay';
  const safeTopDirective = needsSafeTopBias
    ? `Wide composition with an empty open sky or plain low-detail background across the upper portion of the frame. All characters, faces, objects, and key details sit in the lower portion.\n\n`
    : '';

  // OST baking. Sanitise stray newlines and cap at 120 chars so a
  // malformed string can't smuggle other directives into the prompt.
  // The phrase is repeated, terse, at the end of the prompt because
  // image models weight late tokens heavily for "what must appear in
  // the image".
  const safeOnScreenText = (input.onScreenText ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
  const escapedOst = safeOnScreenText.replace(/"/g, '\\"');
  const shouldBakeOst = normalizedOstMode === 'bake' && safeOnScreenText.length > 0;
  // OST sits below the stripe only when the stripe overlays the image.
  // Letterbox layout already crops the canvas so OST can land anywhere.
  const ostPosition = needsSafeTopBias
    ? 'in the lower portion of the frame'
    : 'within the scene';
  const ostLeadingDirective = shouldBakeOst
    ? `Hand-lettered text "${escapedOst}" drawn large in bold marker style ${ostPosition}, in the illustration's own style.\n\n`
    : '';
  const ostTrailingDirective = shouldBakeOst
    ? `\n\nText shown: "${escapedOst}".`
    : '';

  // Cloud-Kie style-sheet chaining hint. Sanitised + capped at 240
  // chars before injection — same belt-and-braces as the OST
  // sanitiser above.
  const safeSheetDesc = (input.styleSheetDescription ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
  const sheetDescDirective = safeSheetDesc
    ? `\n\nMaintain visual continuity with the established style: ${safeSheetDesc}.`
    : '';

  // Length cap is on the final augmented prompt — what we ACTUALLY send
  // to the model. Truncate the user-supplied body from the tail so the
  // most-important leading text (the scene body) is preserved. The 4-char
  // slack mirrors the historical inline block; trimming a partial word
  // at the truncation boundary may eat a few extra chars beyond the
  // strict budget.
  const fixedOverhead = safeTopDirective.length + ostLeadingDirective.length + ostTrailingDirective.length + sheetDescDirective.length;
  const promptBudget = Math.max(200, input.promptCap - fixedOverhead - 4);
  const trimmedBody = input.prompt.trim();
  const originalBodyLen = trimmedBody.length;
  let safeBody = trimmedBody;
  let truncated = false;
  if (safeBody.length > promptBudget) {
    safeBody = safeBody.slice(0, promptBudget).replace(/\s+\S*$/, '').trimEnd();
    truncated = true;
    logger.info('[prompt-augmentation truncated]', {
      source: input.source ?? 'unknown',
      originalLen: originalBodyLen,
      truncatedLen: safeBody.length,
      budget: promptBudget,
      fixedOverhead,
      promptCap: input.promptCap,
    });
  }

  const finalPrompt = `${safeTopDirective}${ostLeadingDirective}${safeBody}${ostTrailingDirective}${sheetDescDirective}`;

  return {
    prompt: finalPrompt,
    truncated,
    originalBodyLen,
    finalBodyLen: safeBody.length,
    fixedOverhead,
    promptBudget,
    ostBaked: shouldBakeOst,
    safeTop: needsSafeTopBias,
    sheetDesc: safeSheetDesc.length > 0,
  };
}
