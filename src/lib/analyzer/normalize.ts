/**
 * Server-side normalization for an `AnalyzedVideo` after Gemini has
 * returned it and the structural guard has accepted it. Two things
 * happen here, both of which the Phase 0 fidelity eval flagged as
 * real defects:
 *
 *   1. style_packs[].occupies_seconds is recomputed deterministically
 *      from the scenes that reference each pack id. Gemini's own
 *      per-pack runtime numbers were observed to disagree with the
 *      summed scene runtimes by hundreds of seconds (Reference A's
 *      889 vs 1949 mismatch) — that field is derivable, so we derive
 *      it instead of trusting Gemini's arithmetic.
 *
 *   2. Scene-boundary consistency is checked against meta.duration_seconds.
 *      When scenes overflow / underflow / overlap, we collect human-
 *      readable warnings rather than silently mutating Gemini's
 *      output. The route logs the warnings and surfaces them in the
 *      response so the operator UI can render them. We deliberately
 *      do NOT clamp scene boundaries here because every scene's
 *      timing could be wrong (Reference B's scenes were stretched by
 *      ~58% across the board), and clamping just the last one would
 *      paper over the bigger problem.
 *
 * The shape of `AnalyzedVideo` is unchanged — this module returns a
 * structurally-identical video plus a separate `warnings` array. The
 * route decides where to surface the warnings.
 */

import type { AnalyzedVideo } from './types';

export interface NormalizedAnalysis {
  video: AnalyzedVideo;
  warnings: string[];
}

const SCENE_DURATION_TOLERANCE_SECONDS = 2;
const SCENE_OVERLAP_TOLERANCE_SECONDS = 0.5;

/**
 * Recomputes derived per-pack runtime fields from the scene list and
 * collects consistency warnings about scene boundaries. Does not
 * mutate Gemini's source-of-truth fields (scene boundaries, pack
 * identities, anything operator-visible besides the derived
 * occupies_seconds).
 */
export function normalizeAnalyzedVideo(input: AnalyzedVideo): NormalizedAnalysis {
  const warnings: string[] = [];
  const duration = input.meta.duration_seconds;

  warnings.push(...checkSceneBoundaries(input, duration));
  warnings.push(...checkChapterBoundaries(input, duration));
  warnings.push(...checkUnknownScenePackIds(input));

  const occupiesByPack = sumSceneDurationsByPack(input);
  const style_packs = input.style_packs.map((pack) => {
    const summed = occupiesByPack.get(pack.id) ?? 0;
    return summed === pack.occupies_seconds ? pack : { ...pack, occupies_seconds: summed };
  });

  const video: AnalyzedVideo = { ...input, style_packs };
  return { video, warnings };
}

function checkSceneBoundaries(video: AnalyzedVideo, duration: number): string[] {
  const out: string[] = [];
  const scenes = video.scenes;
  if (scenes.length === 0) {
    out.push('scenes: empty array (analyzer should always emit at least one scene covering the runtime)');
    return out;
  }

  if (scenes[0].start > SCENE_DURATION_TOLERANCE_SECONDS) {
    out.push(`scenes[0].start: ${scenes[0].start}s — expected 0 within ±${SCENE_DURATION_TOLERANCE_SECONDS}s tolerance`);
  }

  const lastEnd = scenes[scenes.length - 1].end;
  const endDelta = lastEnd - duration;
  if (Math.abs(endDelta) > SCENE_DURATION_TOLERANCE_SECONDS) {
    const direction = endDelta > 0 ? 'overflow' : 'underflow';
    out.push(
      `scenes[last].end ${direction}: ${lastEnd}s vs meta.duration_seconds=${duration}s (Δ=${endDelta.toFixed(1)}s, ${((endDelta / Math.max(duration, 1)) * 100).toFixed(1)}%)`,
    );
  }

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1];
    const curr = scenes[i];
    const gap = curr.start - prev.end;
    if (gap > SCENE_OVERLAP_TOLERANCE_SECONDS) {
      out.push(`scenes[${i - 1}..${i}]: gap of ${gap.toFixed(1)}s — scenes should cover the runtime contiguously`);
    } else if (gap < -SCENE_OVERLAP_TOLERANCE_SECONDS) {
      out.push(`scenes[${i - 1}..${i}]: overlap of ${(-gap).toFixed(1)}s — scenes should be non-overlapping`);
    }
  }

  return out;
}

function checkChapterBoundaries(video: AnalyzedVideo, duration: number): string[] {
  const out: string[] = [];
  const chapters = video.transcript.chapters;
  // Chapters are optional — Gemini may legitimately omit them for very
  // short or unstructured videos. Only validate when at least one
  // chapter is present.
  if (chapters.length === 0) return out;

  if (chapters[0].start > SCENE_DURATION_TOLERANCE_SECONDS) {
    out.push(
      `chapters[0].start: ${chapters[0].start}s — expected 0 within ±${SCENE_DURATION_TOLERANCE_SECONDS}s tolerance`,
    );
  }

  const lastEnd = chapters[chapters.length - 1].end;
  const endDelta = lastEnd - duration;
  if (Math.abs(endDelta) > SCENE_DURATION_TOLERANCE_SECONDS) {
    const direction = endDelta > 0 ? 'overflow' : 'underflow';
    out.push(
      `chapters[last].end ${direction}: ${lastEnd}s vs meta.duration_seconds=${duration}s (Δ=${endDelta.toFixed(1)}s, ${((endDelta / Math.max(duration, 1)) * 100).toFixed(1)}%)`,
    );
  }

  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const curr = chapters[i];
    const gap = curr.start - prev.end;
    if (gap > SCENE_OVERLAP_TOLERANCE_SECONDS) {
      out.push(`chapters[${i - 1}..${i}]: gap of ${gap.toFixed(1)}s — chapters should cover the runtime contiguously`);
    } else if (gap < -SCENE_OVERLAP_TOLERANCE_SECONDS) {
      out.push(`chapters[${i - 1}..${i}]: overlap of ${(-gap).toFixed(1)}s — chapters should be non-overlapping`);
    }
  }

  return out;
}

function checkUnknownScenePackIds(video: AnalyzedVideo): string[] {
  const knownPackIds = new Set(video.style_packs.map((p) => p.id));
  const unknown = new Set<string>();
  for (const scene of video.scenes) {
    if (!knownPackIds.has(scene.style_pack_id)) unknown.add(scene.style_pack_id);
  }
  return Array.from(unknown, (id) => `scenes: style_pack_id "${id}" is not present in style_packs[].id`);
}

function sumSceneDurationsByPack(video: AnalyzedVideo): Map<string, number> {
  const sums = new Map<string, number>();
  for (const scene of video.scenes) {
    const duration = Math.max(0, scene.end - scene.start);
    sums.set(scene.style_pack_id, (sums.get(scene.style_pack_id) ?? 0) + duration);
  }
  return sums;
}
