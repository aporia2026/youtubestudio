/**
 * Inbox asset-status helper — Phase 15.8 follow-up.
 *
 * The Shorts inbox needs to tell the user whether the per-style render
 * assets for a `short_native` row are ready, still generating in the
 * background, or not applicable (Minimal style, or clip rows). This
 * pure helper centralises the decision so the badge, the polling loop,
 * and the retry button all agree.
 *
 * Status states:
 *   - 'none'       — no badge. Applies when the style is Minimal (assets
 *                    aren't needed), when the row is a `short_clip`
 *                    (Mode A recommendation, no render), or when no
 *                    style is picked yet.
 *   - 'generating' — the row has a Doodle / Paint style_id but the
 *                    style_assets blob for that style isn't populated
 *                    yet (no base_url). This is the auto-polled state.
 *   - 'ready'      — the row's style_assets carries the matching
 *                    style block with a base_url. Render is unblocked.
 */

import type { ShortRow } from './shorts-types';

export type StyleAssetStatus = 'none' | 'generating' | 'ready';

/** Pure helper — given a row, decide which status the inbox should show.
 *  Exported for tests so badge logic + polling loop + retry button all
 *  agree on which rows need attention. */
export function getStyleAssetStatus(
  row: Pick<ShortRow, 'medium' | 'style_id' | 'style_assets'>,
): StyleAssetStatus {
  // Clip recommendations don't render via the Remotion pipeline — they're
  // pointers the user cuts in YT Studio. No assets ever apply.
  if (row.medium !== 'short_native') return 'none';

  // No style picked yet → Minimal at render time, no assets needed.
  if (!row.style_id || row.style_id === 'minimal_gradient_v1') return 'none';

  if (row.style_id === 'doodle_explainer_2_short') {
    return row.style_assets?.doodle?.base_url ? 'ready' : 'generating';
  }
  if (row.style_id === 'paint_explainer_v1_short') {
    return row.style_assets?.paint?.base_url ? 'ready' : 'generating';
  }

  // Unknown style id — defensive: treat as no badge so a future style
  // entry not handled here doesn't render as eternally "generating."
  return 'none';
}

/** Returns the per-style display label for the badge. */
export function styleAssetLabel(styleId: string | null | undefined): string {
  switch (styleId) {
    case 'doodle_explainer_2_short':
      return 'Doodle';
    case 'paint_explainer_v1_short':
      return 'Paint';
    case 'minimal_gradient_v1':
      return 'Minimal';
    default:
      return 'Style';
  }
}

/** Returns true when at least one row in the list needs the polling
 *  loop. The inbox panel uses this to start/stop the interval. */
export function anyRowGenerating(
  rows: Array<Pick<ShortRow, 'medium' | 'style_id' | 'style_assets'>>,
): boolean {
  return rows.some((r) => getStyleAssetStatus(r) === 'generating');
}
