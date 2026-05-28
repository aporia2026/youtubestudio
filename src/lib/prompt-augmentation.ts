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
import { buildCharacterBiblePrefix } from './character-bible';

/** Total char cap for the single-shot route's augmented prompt. */
export const SINGLE_SHOT_PROMPT_CAP = 2000;

/** Total char cap for a single collage cell's augmented prompt. With a
 *  ~250-char collage template and 4 cells, the composed prompt lands at
 *  ~2650 chars — well within Kie request body limits. */
export const COLLAGE_CELL_PROMPT_CAP = 600;

// `SAFE_FRAMING_EDIT_SUFFIX` lives in `./prompt-framing` so the Edit-path
// helpers reached from client components (`composeVariantEditRequest` in
// `remotion/utils.ts`) can import it without dragging this module's
// server-only `logger` dependency into the client bundle. Server callers
// that want both `augmentCellPrompt` and the suffix import them from
// their respective modules.

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
  /** Phase 2 (Character Bible) — per-doc map from character_id slug
   *  to a 1-2 sentence visual description. When non-empty, a
   *  "Character reference for this scene" block is prepended to the
   *  prompt BEFORE the safe-edge / OST directives so the model sees
   *  the bible at the very top of its prompt window. Same value the
   *  caller would read from `doc.doodle_explainer_2_character_descriptions`.
   *  Passing undefined / empty map is a no-op (back-compat). */
  characterDescriptions?: Record<string, string>;
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

  // Safe-edge margin guard — always-on. Single canonical 15% statement,
  // combining positive ("content sits in central 70%") and negative ("nothing
  // in the outer 15% bands") phrasing. The margin is 15% not 10% because:
  //   1. The Atlas GPT-Image-2 i2i + variant + collage paths generate at
  //      1536×1024 (3:2) and the dispatcher center-crops to 1536×864 (16:9).
  //      That crop destroys 80px = 7.8% off the TOP and another 7.8% off the
  //      BOTTOM. A 15% directive gives the model ~7% of headroom over the
  //      destroy band — enough that even drift past spec lands inside the
  //      visible safe area.
  //   2. Diffusion models follow positive composition language ("content
  //      occupies central 70%") much more reliably than negative prohibitions
  //      ("no content within X%"). Combining both is more robust than either
  //      alone.
  // This block is the ONLY place 15% / central 70% is asserted by augmentCellPrompt.
  // ostSafeEdgeReinforcement was removed in this revision because re-stating
  // the same numbers under a different directive name was producing
  // "tiny floating heads in empty canvases" on close-up portraits — the
  // model concatenates emphasis when the same constraint repeats with the
  // same numbers. Below, safeTopDirective and ostLeadingDirective reference
  // the safe zone by name but do NOT re-assert percentages.
  const safeEdgeDirective =
    `Wide composition with empty whitespace padding across the top 15% and bottom 15% of the canvas. All characters, faces, text, props, and key details occupy the central 70% of the frame, with generous vertical breathing room. The image will be cropped at the top and bottom — anything placed in the outer 15% bands is lost. No element touches or extends past any edge of the canvas.\n\n`;

  // Safe-top scene bias — only useful when the stripe will overlay the
  // image (covering its top). When the stripe is letterboxed, the
  // generation already targets a shrunken canvas, so biasing the prompt
  // is redundant and only crowds the input.
  // Wording does NOT re-assert "15%" — the safeEdgeDirective above is the
  // canonical source. This directive only adds the overlay-specific
  // "empty sky in the upper portion" composition hint.
  const hasSectionStripe = Boolean(input.sectionTitle?.trim());
  const needsSafeTopBias = hasSectionStripe && normalizedLayout === 'overlay';
  const safeTopDirective = needsSafeTopBias
    ? `Bias the upper portion of the central safe zone toward an empty open sky or plain low-detail background. All characters, faces, objects, and key details sit in the lower portion of the safe zone.\n\n`
    : '';

  // OST baking. Sanitise stray newlines and cap at 120 chars so a
  // malformed string can't smuggle other directives into the prompt.
  // The phrase is repeated, terse, at the end of the prompt because
  // image models weight late tokens heavily for "what must appear in
  // the image".
  const safeOnScreenText = (input.onScreenText ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
  const escapedOst = safeOnScreenText.replace(/"/g, '\\"');
  const shouldBakeOst = normalizedOstMode === 'bake' && safeOnScreenText.length > 0;
  // OST positioning + size constraint.
  //
  // 2026-05-28 second-pass framing fix. The first pass (consolidated
  // safe-edge directive + removed ostSafeEdgeReinforcement) shipped at
  // 19:53 UTC. The user reported within 30 min that baked OST text was
  // still rendering with letter baselines flush at the bottom edge of
  // the canvas — observed on a "30,000 APPOINTMENTS" doodle frame where
  // the word "APPOINTMENTS" occupied ~30% of canvas height with its
  // bottom at y=100%. Two root causes the first pass missed:
  //   1. NO SIZE CAP. "drawn large in bold marker style" gave the
  //      model license to fill the lower half. With a long OST string
  //      ("30,000 APPOINTMENTS"), "large" maps to ~30% of canvas
  //      height, which guarantees a 15% bottom margin is impossible.
  //   2. The "lower-center" position bias + canonical safeEdgeDirective
  //      ("bottom 15%") were in tension. The OST directive's specific
  //      position language won over the global edge directive — the
  //      model treats OST as the highest-priority element and ignores
  //      the global framing for that element.
  //
  // Resolution:
  //   - Explicit size cap ("no taller than 20% of canvas height").
  //   - Explicit per-element anti-bottom-edge clause inside the OST
  //     directive itself (not relying on the global safeEdgeDirective
  //     to apply to OST).
  //   - Position shifted from "lower-center" → "center, slightly
  //     below middle". "Lower" plus "large" was the combo that pushed
  //     glyphs to the cut line.
  //   - The anti-top-edge clause stays (year-shaped OST like "1945"
  //     still trips the model's title-placement prior). Now BOTH top
  //     and bottom edges are explicitly named in the OST directive.
  const ostPosition = needsSafeTopBias
    ? 'in the lower portion of the central safe zone, slightly below the vertical middle, NEVER near the top edge and NEVER near the bottom edge'
    : 'centered horizontally and positioned slightly below the vertical middle of the frame, NEVER near the top edge and NEVER near the bottom edge';
  const ostLeadingDirective = shouldBakeOst
    ? `Hand-lettered text "${escapedOst}" drawn in bold marker style at a moderate readable size (the text occupies NO MORE than 20% of the total canvas height; letters are NOT oversized), positioned ${ostPosition}, in the illustration's own style. The full text — including the lowest baseline of every letter — sits with AT LEAST 15% empty whitespace below it before the bottom edge of the canvas. Letters must NEVER touch or cross the bottom edge.\n\n`
    : '';
  const ostTrailingDirective = shouldBakeOst
    ? `\n\nText shown: "${escapedOst}" (moderate size, well clear of top and bottom edges).`
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
  // Phase 2 (Character Bible) — prepend the doc-level character bible
  // BEFORE every other directive so the model sees consistent
  // reference language for recurring characters at the very top of
  // its prompt window. Empty / missing descriptions → empty prefix
  // (no-op for back-compat). See `src/lib/character-bible.ts` for the
  // prefix shape. The prefix is counted in fixedOverhead so the body
  // budget shrinks accordingly when descriptions are present.
  const characterBiblePrefix = buildCharacterBiblePrefix(input.characterDescriptions);
  const fixedOverhead =
    characterBiblePrefix.length
    + safeEdgeDirective.length
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

  const finalPrompt = `${characterBiblePrefix}${safeEdgeDirective}${safeTopDirective}${ostLeadingDirective}${safeBody}${ostTrailingDirective}${sheetDescDirective}`;

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
