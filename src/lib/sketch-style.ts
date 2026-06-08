/**
 * White-background sketch style detector.
 *
 * Some production-doc styles render as hand-drawn art on a plain white
 * canvas (the doodle / paint-explainer / whiteboard family). Photo-
 * trained inpainting models like Ideogram v3-edit produce noisy
 * mosaic garbage on those — they have no idea what doodle pixels look
 * like and try to hallucinate photo-style detail.
 *
 * For these styles, the erase action is correct as a deterministic
 * white-fill composite (paint white over the masked region) instead of
 * a paid AI inpaint. Same visual result, zero cost, instant.
 *
 * Kept as a pure helper in its own file so the editor, the production-
 * doc page, and unit tests share one resolution.
 */

const WHITE_BACKGROUND_SKETCH_STYLE_IDS: ReadonlySet<string> = new Set([
  'doodle_explainer',
  'doodle_explainer_2',
  'paint_explainer_v1',
  'whiteboard',
]);

/** True when the style id is a built-in white-background sketch style.
 *  User-defined styles (UUIDs) always return false — they could be
 *  anything, and we don't want to silently white-fill into a custom
 *  style the user expected the AI to inpaint. */
export function isWhiteBackgroundSketchStyle(styleId: string | undefined | null): boolean {
  if (!styleId) return false;
  return WHITE_BACKGROUND_SKETCH_STYLE_IDS.has(styleId);
}
