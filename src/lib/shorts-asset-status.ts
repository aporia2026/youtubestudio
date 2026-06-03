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

import type { GenerationProgressState, ShortRow } from './shorts-types';

export type StyleAssetStatus = 'none' | 'generating' | 'ready';

/** Max time an in-flight job may go WITHOUT any progress update before the
 *  UI treats it as dead. Phase 15.16 moved generation to a background cron
 *  that heartbeats `updated_at` on every step (plan / base / each variant
 *  batch) and reclaims its own stalled jobs across ticks — so a healthy job
 *  refreshes well within this window even across retries spread over a few
 *  ticks. Exceeding it means nothing is advancing the row at all (cron down
 *  / misconfigured, or the job was orphaned before the cron existed), so we
 *  stop polling and surface a Retry instead of a forever-climbing bar.
 *
 *  Anchored on the LAST update, not the start, on purpose: under the cron a
 *  job legitimately runs longer than any single-request deadline; only a
 *  gap in heartbeats signals death. */
export const SHORTS_ASSET_STALE_MS = 300_000;

const IN_FLIGHT_PHASES: ReadonlySet<string> = new Set(['queued', 'planning', 'base', 'variant']);

/** Pure helper — true when a generation_progress row is still "in flight"
 *  but hasn't been touched within `SHORTS_ASSET_STALE_MS`, i.e. nothing is
 *  advancing it. `nowMs` is injected so this stays pure + testable. Returns
 *  false for terminal ('done' / 'error') or empty progress, and for rows
 *  with no parseable timestamp. Falls back to `started_at` when
 *  `updated_at` is absent (legacy rows). */
export function isGenerationStale(
  progress: Pick<GenerationProgressState, 'phase' | 'started_at' | 'updated_at'> | null | undefined,
  nowMs: number,
): boolean {
  if (!progress?.phase || !IN_FLIGHT_PHASES.has(progress.phase)) return false;
  const anchor = progress.updated_at ?? progress.started_at;
  if (!anchor) return false;
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs)) return false;
  return nowMs - anchorMs > SHORTS_ASSET_STALE_MS;
}

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
