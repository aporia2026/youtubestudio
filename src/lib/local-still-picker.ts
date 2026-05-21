/**
 * Pick the right local still-generation model for a production-doc row.
 *
 * Codifies the evidence from the model-comparison smoke
 * (`hiccup-analysis/compare_local_*.py`, viewable at
 * `/local-studio/compare`):
 *
 *   - Flux schnell garbles glyphs on baked-text rows ("BREAKIING REAK
 *     NEWS" vs. the clean Qwen output).
 *   - Flux schnell anchors too hard to the i2i reference at denoise 0.7
 *     (the Phase 7 style-sheet chain) — output ≈ copy of the reference,
 *     barely responsive to the scene prompt. Qwen-Image at the same
 *     denoise actually follows the prompt while keeping the style.
 *   - For everything else, Flux schnell is ~9× faster than Qwen at
 *     comparable enough quality to be the right batch default.
 *
 * Local-only. Cloud Kie defaults are untouched — see
 * `_plans/2026-05-21-phase-6-v2-smart-local-still-batch.md`.
 */

export type LocalStillModel = 'flux-schnell-local' | 'qwen-image-local';

export type PickReason = 'baked_text' | 'style_sheet' | 'default';

export interface PickInput {
  row: {
    on_screen_text?: string | null;
    on_screen_text_mode?: 'bake' | 'overlay' | 'none';
  };
  doc: {
    style_sheet_url?: string | null;
    on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
  };
}

export interface PickResult {
  model: LocalStillModel;
  reason: PickReason;
}

/** Resolve `on_screen_text_mode` against the doc default. Mirrors the
 *  fallback chain in `productionDocToVideoConfig` and the image route. */
function resolveOstMode(input: PickInput): 'bake' | 'overlay' | 'none' {
  return (
    input.row.on_screen_text_mode ??
    input.doc.on_screen_text_mode_default ??
    'bake'
  );
}

export function pickLocalStillModel(input: PickInput): PickResult {
  const ostMode = resolveOstMode(input);
  const ostText = (input.row.on_screen_text ?? '').trim();
  if (ostMode === 'bake' && ostText.length > 0) {
    return { model: 'qwen-image-local', reason: 'baked_text' };
  }
  if (input.doc.style_sheet_url && input.doc.style_sheet_url.trim().length > 0) {
    return { model: 'qwen-image-local', reason: 'style_sheet' };
  }
  return { model: 'flux-schnell-local', reason: 'default' };
}
