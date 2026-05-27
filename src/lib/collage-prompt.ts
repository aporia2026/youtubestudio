/**
 * Compose the 4 cell prompts into a 2×2 collage instruction sent to
 * the image model. Shared between the production collage route and
 * the dev tester endpoint so both surfaces produce identical prompts
 * (same template, same retry suffix) — important because the tester
 * is the instrument we use to validate behaviour the real flow
 * depends on.
 *
 * `reinforced = true` appends a stronger directive that tells the
 * model each cell must contain a unique fully-rendered scene. Used
 * on the retry pass after malformed-quadrant detection fires.
 *
 * Cells are expected to be already-augmented strings — OST baking,
 * safe-top bias, and sheet-description hints are applied per cell by
 * the caller via `augmentCellPrompt`. This module only wraps the
 * augmented cells in the 2×2 grid template. See
 * `_plans/2026-05-26-collage-default-on-with-per-cell-augmentation.md`
 * and `_plans/2026-05-24-system-upscale-and-collage.md`.
 */

const LABELS = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'] as const;

export function composeCollagePrompt(cells: readonly string[], reinforced: boolean): string {
  const cellLines = cells.map((c, i) => `${LABELS[i]}: ${c}`).join('\n');
  const base =
    'A 2x2 grid collage of 4 distinct 16:9 cinematic scenes, separated by a thin neutral grey border (10px). '
    + 'Each cell is a complete, standalone scene with no visual elements bleeding into adjacent cells.\n\n'
    + cellLines;
  if (!reinforced) return base;
  return `${base}\n\nIMPORTANT: Each of the four cells must contain a unique, fully-rendered scene with clear subject matter. No blank, repeated, or near-empty cells.`;
}
