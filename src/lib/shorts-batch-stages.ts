/**
 * Client-safe pure helpers for the shorts-batch orchestrator's
 * per-short stage derivation. Lives in its own module so client
 * components (Step3Progress) can import them without dragging the
 * server-only orchestrator (which transitively pulls in
 * `shorts.ts` → `audio-duration-probe` → `child_process` and the
 * Google TTS SDK) into the browser bundle.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Mirrors the convention `shorts-types.ts` vs `shorts.ts` use: types
 * + pure logic in a client-safe module, server-only side effects in
 * the sibling `-orchestrator.ts`.
 */

import type { ShortRow } from './shorts-types';

/** Per-short stage names.
 *  - 'trigger_render' fires once assets are produced but the final
 *    mp4 hasn't been rendered yet — the orchestrator calls the
 *    render route to kick it off.
 *  - 'awaiting_render' is the post-trigger waiting state (render
 *    in flight, rendered_video_url still null).
 *  - 'terminal' means either the render finished OR the generation
 *    pipeline errored. */
export type BatchStage =
  | 'extract'
  | 'voiceover'
  | 'seo'
  | 'trigger_render'
  | 'awaiting_render'
  | 'terminal';

/** A short is "terminal" (the orchestrator is done with it) when
 *  either render finished OR the generation pipeline errored. */
export function isShortTerminal(short: ShortRow): boolean {
  if (short.rendered_video_url) return true;
  if (short.generation_progress?.phase === 'error') return true;
  return false;
}

/** Derive the next stage from observable columns. The orchestrator
 *  picks shorts whose stage is `extract` | `voiceover` | `seo` |
 *  `trigger_render` and skips the rest.
 *
 *  ⚠ Asset-readiness check is load-bearing — it gates when the
 *  orchestrator hands off to the render route. Two real bugs were
 *  fixed 2026-06-10:
 *    1. The cron writes the base frame URL onto
 *       `style_assets.doodle.base_url` BEFORE any variants are
 *       generated (the 'base' phase). The old check fired render the
 *       moment the doodle block existed, triggering Lambda renders
 *       against half-baked assets that hung or crashed.
 *    2. `finalizeDone` in the asset cron clears
 *       `generation_progress = '{}'` instead of setting
 *       `phase: 'done'`, so the `phase === 'done'` branch never
 *       actually fired in practice. The new check ignores that branch
 *       and uses observable post-finalize state instead: cron has
 *       released the lease (phase missing) AND at least one variant
 *       landed on `style_assets[styleKey].variants`. The phase guard
 *       prevents triggering while the cron is still mid-flight in
 *       'queued' / 'planning' / 'base' / 'variant' / 'error'.
 */
export function nextStageFor(short: ShortRow): BatchStage {
  if (isShortTerminal(short)) return 'terminal';
  if (!short.short_script) return 'extract';
  if (!short.voiceover_audio_url) return 'voiceover';
  if (!short.seo_result) return 'seo';
  if (short.rendered_video_url) return 'terminal';
  const phase = short.generation_progress?.phase;
  // 'rendering' is the marker the trigger sets to prevent re-firing
  // on the next tick before rendered_video_url shows up.
  if (phase === 'rendering') return 'awaiting_render';
  // Cron is mid-flight or errored — wait, don't trigger.
  if (phase === 'queued' || phase === 'planning' || phase === 'base' || phase === 'variant') {
    return 'awaiting_render';
  }
  // Cron has cleared its progress (finalizeDone). Per QA H2, styles
  // without a variant-bearing asset block (minimal_gradient_v1 and any
  // future text-only / gradient-only styles) need to skip the
  // variants-present gate or they'd deadlock in 'awaiting_render'
  // forever. The minimal style writes `style_assets = {}` synchronously
  // and is renderable as-is. Treat any non-frame-bearing style as
  // "render-ready" the moment SEO is done. The known frame-bearing
  // styles list is the source of truth; everything else falls through.
  const styleId = short.style_id;
  const FRAME_BEARING_STYLES = new Set(['doodle_explainer_2_short', 'paint_explainer_v1_short']);
  if (styleId !== null && !FRAME_BEARING_STYLES.has(styleId)) {
    // Non-frame styles (e.g. minimal_gradient_v1): no variants to
    // wait for; the renderer composes from script + voiceover alone.
    return 'trigger_render';
  }
  // Frame-bearing styles (or unset style_id, which means the
  // orchestrator hasn't enqueued yet and will default to doodle):
  // require at least one variant before triggering render — a bare
  // base_url is not a renderable Short.
  const doodleVariants = short.style_assets?.doodle?.variants?.length ?? 0;
  const paintVariants = short.style_assets?.paint?.variants?.length ?? 0;
  if (doodleVariants > 0 || paintVariants > 0) return 'trigger_render';
  return 'awaiting_render';
}

/** True when every short in the cohort is at a terminal state. The
 *  orchestrator uses this to decide whether to transition the batch
 *  out of 'generating' into 'review'. */
export function allShortsAtTerminal(shorts: readonly ShortRow[]): boolean {
  return shorts.every(isShortTerminal);
}
