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

import type { AnalyzedScene, AnalyzedVideo } from './types';

export interface NormalizedAnalysis {
  video: AnalyzedVideo;
  warnings: string[];
}

const SCENE_DURATION_TOLERANCE_SECONDS = 2;
const SCENE_OVERLAP_TOLERANCE_SECONDS = 0.5;

/**
 * Recomputes derived per-pack runtime fields from the scene list,
 * applies chapter-aware scene rescaling when scene boundaries overflow
 * `meta.duration_seconds`, and collects consistency warnings about
 * anything still inconsistent after the rescale.
 *
 * The rescale step is the v1.5.0 fix for the long-standing scene-
 * overflow defect: Gemini reliably hallucinates scene end-times on
 * longer montages (Casey's "Make It Count" runs claim 437s of scenes
 * for a 277s video) but reliably honors the chapter-boundary rule
 * (chapters DO end at duration_seconds). When chapters are trustworthy
 * we use them as anchors to proportionally compress scenes that
 * overflow their chapter — the relative scene durations within a
 * chapter are preserved, only the absolute scale changes. Lossy but
 * deterministic; the warning trail records which chapters were
 * rescaled and by how much.
 *
 * Chapter rescale skips when chapters are themselves out of bounds
 * (don't trust an unreliable anchor) or absent.
 */
export function normalizeAnalyzedVideo(input: AnalyzedVideo): NormalizedAnalysis {
  const warnings: string[] = [];
  const duration = input.meta.duration_seconds;

  // Apply chapter-aware scaling first so the subsequent boundary
  // checks see the corrected scene list.
  const { scenes: rescaledScenes, warnings: rescaleWarnings } = rescaleScenesToChapters(input, duration);
  const rescaled: AnalyzedVideo = { ...input, scenes: rescaledScenes };
  warnings.push(...rescaleWarnings);

  warnings.push(...checkSceneBoundaries(rescaled, duration));
  warnings.push(...checkChapterBoundaries(rescaled, duration));
  warnings.push(...checkUnknownScenePackIds(rescaled));

  const occupiesByPack = sumSceneDurationsByPack(rescaled);
  const style_packs = rescaled.style_packs.map((pack) => {
    const summed = occupiesByPack.get(pack.id) ?? 0;
    return summed === pack.occupies_seconds ? pack : { ...pack, occupies_seconds: summed };
  });

  const video: AnalyzedVideo = { ...rescaled, style_packs };
  return { video, warnings };
}

/**
 * If chapters are trustworthy (last chapter ends at duration_seconds
 * within tolerance) and scenes overflow into wrong-time space, scale
 * each chapter's scenes proportionally to fit within its bounds. Pure
 * over the input — returns a new scenes array and any per-chapter
 * rescale notices. When there are no chapters, or chapters themselves
 * overflow, or scenes already fit, returns the input unchanged.
 */
export function rescaleScenesToChapters(
  input: AnalyzedVideo,
  duration: number,
): { scenes: AnalyzedScene[]; warnings: string[] } {
  const chapters = input.transcript.chapters;
  const scenes = input.scenes;
  if (chapters.length === 0 || scenes.length === 0) return { scenes, warnings: [] };

  // Don't rescale against unreliable chapter anchors.
  const lastChapterEnd = chapters[chapters.length - 1].end;
  if (Math.abs(lastChapterEnd - duration) > SCENE_DURATION_TOLERANCE_SECONDS) {
    return { scenes, warnings: [] };
  }
  // No-op when scenes already fit — common when Gemini behaves.
  const lastSceneEnd = scenes[scenes.length - 1].end;
  if (Math.abs(lastSceneEnd - duration) <= SCENE_DURATION_TOLERANCE_SECONDS) {
    return { scenes, warnings: [] };
  }

  // Group scenes by chapter via scene.start. Because scenes claim to
  // be contiguous (scene[i].start === scene[i-1].end), walking them
  // in order and assigning to the first chapter whose end exceeds
  // scene.start is unambiguous in claimed-time space.
  const groups: Array<{ chapterIdx: number; scenes: AnalyzedScene[] }> = chapters.map((_c, i) => ({
    chapterIdx: i,
    scenes: [],
  }));
  let sceneIdx = 0;
  for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
    const chapter = chapters[cIdx];
    while (sceneIdx < scenes.length) {
      const s = scenes[sceneIdx];
      // A scene is in this chapter if it starts before the chapter
      // ends, OR if this is the last chapter (sweep up any remainder).
      const isLastChapter = cIdx === chapters.length - 1;
      if (!isLastChapter && s.start >= chapter.end) break;
      groups[cIdx].scenes.push(s);
      sceneIdx++;
    }
  }

  const warnings: string[] = [];
  const outScenes: AnalyzedScene[] = [];
  for (const group of groups) {
    const chapter = chapters[group.chapterIdx];
    if (group.scenes.length === 0) continue;

    const firstScene = group.scenes[0];
    const lastScene = group.scenes[group.scenes.length - 1];
    const claimedSpan = Math.max(0.001, lastScene.end - firstScene.start);
    const targetSpan = Math.max(0, chapter.end - chapter.start);

    // If this chapter's scenes already fit, leave them untouched.
    if (Math.abs(claimedSpan - targetSpan) <= SCENE_DURATION_TOLERANCE_SECONDS) {
      outScenes.push(...group.scenes);
      continue;
    }

    const scale = targetSpan / claimedSpan;
    let cursor = chapter.start;
    const rescaled = group.scenes.map((scene, i) => {
      const claimedDuration = Math.max(0, scene.end - scene.start);
      const newStart = cursor;
      cursor += claimedDuration * scale;
      // Snap the very last scene of the chapter exactly to chapter.end
      // so the contiguity invariant holds even with float drift.
      const newEnd = i === group.scenes.length - 1 ? chapter.end : cursor;
      return { ...scene, start: round1(newStart), end: round1(newEnd) };
    });
    outScenes.push(...rescaled);

    warnings.push(
      `chapter[${group.chapterIdx}] scenes rescaled: ${group.scenes.length} scenes originally spanning ${claimedSpan.toFixed(1)}s compressed/expanded to fit ${targetSpan.toFixed(0)}s chapter (×${scale.toFixed(3)})`,
    );
  }

  return { scenes: outScenes, warnings };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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
