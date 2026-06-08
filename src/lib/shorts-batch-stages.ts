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

/** Per-short stage names. 'awaiting_render' means the orchestrator
 *  is done with the short but the existing asset/render pipeline
 *  still has to produce the rendered video; 'terminal' means either
 *  the render finished OR the generation pipeline errored. */
export type BatchStage = 'extract' | 'voiceover' | 'seo' | 'awaiting_render' | 'terminal';

/** A short is "terminal" (the orchestrator is done with it) when
 *  either render finished OR the generation pipeline errored. */
export function isShortTerminal(short: ShortRow): boolean {
  if (short.rendered_video_url) return true;
  if (short.generation_progress?.phase === 'error') return true;
  return false;
}

/** Derive the next stage from observable columns. The orchestrator
 *  picks shorts whose stage is `extract` | `voiceover` | `seo` and
 *  skips the rest. */
export function nextStageFor(short: ShortRow): BatchStage {
  if (isShortTerminal(short)) return 'terminal';
  if (!short.short_script) return 'extract';
  if (!short.voiceover_audio_url) return 'voiceover';
  if (!short.seo_result) return 'seo';
  if (!short.rendered_video_url) return 'awaiting_render';
  return 'terminal';
}

/** True when every short in the cohort is at a terminal state. The
 *  orchestrator uses this to decide whether to transition the batch
 *  out of 'generating' into 'review'. */
export function allShortsAtTerminal(shorts: readonly ShortRow[]): boolean {
  return shorts.every(isShortTerminal);
}
