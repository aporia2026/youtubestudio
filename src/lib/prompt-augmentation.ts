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
  /** True when the safe-edge directive (always-on margin guard) was
   *  prepended. Only false in defensive code paths — current behaviour
   *  always sets this. */
  safeEdge: boolean;
  /** True when the safe-top scene bias directive was prepended. */
  safeTop: boolean;
  /** True when the sheet-description tail directive was appended. */
  sheetDesc: boolean;
}

/**
 * Apply per-cell augmentation to a raw prompt and return the final
 * string ready for the image model.
 *
 * Directive ordering:
 *   `${safeEdge}${safeTop}${ostLeading}${body}${ostTrailing}${sheetDesc}`
 *
 * `safeEdge` is a structural constraint ("everything fits inside the
 * canvas with margin") so it leads — the model needs to plan composition
 * around it before any content directive lands. Image models weight late
 * tokens heavily for "what must appear in the image", so the OST trailing
 * directive intentionally sits after the body. Sheet description follows
 * it — the visual-continuity hint is the lowest-priority signal in the
 * prompt.
 *
 * History: an earlier version omitted `safeEdge` and only fired
 * `safeTop` for `overlay` layout. Refs bundled with the
 * doodle_explainer_2 built-in style have edge-bleeding text and motifs,
 * which the i2i model faithfully reproduced — producing outputs where the
 * section title was cropped at the top edge and callouts ran off the
 * bottom. Adding an always-on safe-edge directive stops the bleed at the
 * prompt layer (the ref-image cleanup tracked under
 * `_plans/2026-05-27-doodle-explainer-2-ref-bleed-fix.md` stops it at the
 * ref layer).
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

  // Safe-edge margin guard — always-on. Two reasons the margin is 10%,
  // not the more typical 5–6%:
  //   1. The Atlas GPT-Image-2 i2i path (and the pipeline variant path)
  //      generate at 1536×1024 (3:2) and the dispatcher center-crops to
  //      1536×864 (16:9). That crop removes 80px = 7.8% off the TOP and
  //      another 7.8% off the BOTTOM of the model's output. Any element
  //      the model placed closer than ~8% to the top or bottom edge is
  //      destroyed by the crop. A 10% directive gives the model ~2% of
  //      headroom over the destroy band.
  //   2. i2i models also bleed reference-frame content past the visible
  //      canvas edge when refs themselves have edge-bleeding composition
  //      (the doodle_explainer_2 source-video refs were the canonical
  //      example — section titles flush to the top edge, callouts hung
  //      off the bottom). Cleaning the refs is the upstream fix; this
  //      directive is the downstream backstop.
  // Repeated wording ("top, bottom, left, right") + repeated numeric
  // ("10%") because diffusion models obey concrete numbers in the prompt
  // more reliably than abstract "safe area" language.
  const safeEdgeDirective =
    `Composition fits fully inside the visible frame with AT LEAST 10% empty margin from every edge. No text, faces, callouts, props, titles, or background elements extend within 10% of the top, bottom, left, or right edge of the canvas. All important content is centered in the inner 80% of the frame.\n\n`;

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
  // OST positioning. Phase 1.5 (Bug C) tightening: the previous
  // `'within the scene'` default was too vague — diffusion models
  // treated year-shaped OST values like "1945", "1969" as title
  // graphics and placed them flush against the top edge of the
  // canvas, where the dispatcher's 1536×1024 → 1536×864 center-crop
  // then sliced 80px (~7.8%) off the top and cut into the glyphs (QA
  // run on Sodder doc b59e88ad, 2026-05-28). The new wording bans
  // the top edge explicitly and steers the text into the
  // lower-center safe zone whether or not a section stripe is
  // present. Spec:
  // _plans/2026-05-28-doodle-2-phase-1-5-completion.md (R-C).
  const ostPosition = needsSafeTopBias
    ? 'in the lower portion of the frame, well inside the visible safe area, never near the top edge'
    : 'in the lower-center portion of the frame, well inside the visible safe area, never near the top edge';
  const ostLeadingDirective = shouldBakeOst
    ? `Hand-lettered text "${escapedOst}" drawn large in bold marker style ${ostPosition}, in the illustration's own style. The text must sit with AT LEAST 15% empty margin from the top edge of the canvas.\n\n`
    : '';
  const ostTrailingDirective = shouldBakeOst
    ? `\n\nText shown: "${escapedOst}".`
    : '';
  // Phase 1.5 (Bug C): when an OST is being baked, append an explicit
  // anti-top-edge clause to the safe-edge directive. The general 10%
  // safe-edge language was being overridden by the model's
  // title-placement prior for year-shaped values like "1945"; the
  // 15% floor specifically for text/numerals reinforces the anti-top
  // constraint on the exact element that was failing.
  const ostSafeEdgeReinforcement = shouldBakeOst
    ? `Any hand-lettered text, title, or numeral inside the picture sits AT LEAST 15% inside from the top edge — never touching it.\n\n`
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
  const fixedOverhead =
    safeEdgeDirective.length
    + ostSafeEdgeReinforcement.length
    + safeTopDirective.length
    + ostLeadingDirective.length
    + ostTrailingDirective.length
    + sheetDescDirective.length;
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

  const finalPrompt = `${safeEdgeDirective}${ostSafeEdgeReinforcement}${safeTopDirective}${ostLeadingDirective}${safeBody}${ostTrailingDirective}${sheetDescDirective}`;

  return {
    prompt: finalPrompt,
    truncated,
    originalBodyLen,
    finalBodyLen: safeBody.length,
    fixedOverhead,
    promptBudget,
    ostBaked: shouldBakeOst,
    safeEdge: true,
    safeTop: needsSafeTopBias,
    sheetDesc: safeSheetDesc.length > 0,
  };
}
