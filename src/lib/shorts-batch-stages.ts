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
 *  `trigger_render` and skips the rest. */
export function nextStageFor(short: ShortRow): BatchStage {
  if (isShortTerminal(short)) return 'terminal';
  if (!short.short_script) return 'extract';
  if (!short.voiceover_audio_url) return 'voiceover';
  if (!short.seo_result) return 'seo';
  if (short.rendered_video_url) return 'terminal';
  // Assets are produced by the existing shorts asset cron. We track
  // its progress via `generation_progress.phase`. Once the cron
  // reports 'done' (or the short row carries `style_assets` for the
  // resolved style) we hand off to the render route. `rendering` is
  // the marker the trigger sets to prevent re-firing on the next
  // tick before rendered_video_url shows up.
  const phase = short.generation_progress?.phase;
  const assetsReady =
    phase === 'done' ||
    !!(short.style_assets && (short.style_assets.doodle ?? short.style_assets.paint));
  if (assetsReady && phase !== 'rendering') return 'trigger_render';
  return 'awaiting_render';
}

/** True when every short in the cohort is at a terminal state. The
 *  orchestrator uses this to decide whether to transition the batch
 *  out of 'generating' into 'review'. */
export function allShortsAtTerminal(shorts: readonly ShortRow[]): boolean {
  return shorts.every(isShortTerminal);
}
