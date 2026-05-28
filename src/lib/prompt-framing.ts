/**
 * Pure-text framing constants — no IO, no logger, no `process` access,
 * safe to import from any module (server, client, or Remotion bundle).
 *
 * Lives separately from `prompt-augmentation.ts` because that module
 * imports the server-only logger, and `SAFE_FRAMING_EDIT_SUFFIX` is
 * needed by `composeVariantEditRequest` in `remotion/utils.ts` — which
 * is reached from the production-doc page + editor client components.
 * Importing prompt-augmentation directly there would drag the logger
 * into the client bundle and break `process.stdout.write` calls.
 *
 * Plan: _plans/2026-05-28-image-framing-safe-zone-fix.md.
 */

/** Safe-framing suffix appended to Atlas Edit prompts that do NOT flow
 *  through `augmentCellPrompt`. The Edit paths (variant compose,
 *  character continuation, scene continuation) build their own prompts
 *  inline and would otherwise ship to the model with zero framing
 *  instruction — which under the 1536×1024 → 1536×864 center-crop
 *  reliably places characters / text flush at the bottom edge where
 *  the crop destroys them.
 *
 *  Wording mirrors `safeEdgeDirective` inside `augmentCellPrompt` but
 *  is phrased for the Edit context (the model is repositioning existing
 *  elements, not composing from scratch). The two are mutually
 *  exclusive — a prompt that flowed through `augmentCellPrompt` already
 *  carries the safe-edge directive and must NOT also append this
 *  suffix, or we get directive-stacking which produces tiny
 *  floating-head outputs on close-ups (the failure mode the 2026-05-28
 *  framing fix specifically removed). */
export const SAFE_FRAMING_EDIT_SUFFIX =
  ` When repositioning elements in this scene, place all characters, faces, text, props, and key details inside the central 70% of the frame with at least 15% empty padding from the top and bottom edges. Do not extend any element to or past the top or bottom edge of the canvas — anything placed in the outer 15% bands is lost to cropping.`;
