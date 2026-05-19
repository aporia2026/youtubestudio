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
 * Reconstruct scene boundaries when Gemini's emitted timings are
 * inconsistent with `duration_seconds`. Two paths:
 *
 *   1. Chapter-aware rescale — preferred when chapters form a clean
 *      timeline (first.start = 0, last.end = duration, contiguous,
 *      each chapter has positive duration). Group scenes by chapter
 *      via scene.start, scale each chapter's scenes proportionally to
 *      fit its real bounds. Relative scene durations within a chapter
 *      are preserved.
 *
 *   2. Global proportional rescale — fallback when chapters are
 *      themselves broken (last chapter overflows duration, or some
 *      chapter has negative duration). Sum all positive scene
 *      durations and scale the whole list to fit `duration_seconds`.
 *      Lossy but deterministic — always produces a timeline that
 *      starts at 0, ends at duration_seconds, and is contiguous.
 *
 * No-op when scenes already form a clean timeline (every scene has
 * positive duration, first starts at 0, last ends at duration, no
 * gaps or overlaps). The "scenes already fit" check used to look only
 * at the last scene's end; that missed the v1.5.0 Casey case where
 * Gemini partially obeyed rule #12 by clamping the last end to
 * duration while leaving intermediate scenes overflowing — the chain
 * was broken in the middle, not the end.
 */
export function rescaleScenesToChapters(
  input: AnalyzedVideo,
  duration: number,
): { scenes: AnalyzedScene[]; warnings: string[] } {
  const chapters = input.transcript.chapters;
  const scenes = input.scenes;
  if (scenes.length === 0) return { scenes, warnings: [] };

  if (scenesFormCleanTimeline(scenes, duration)) {
    return { scenes, warnings: [] };
  }

  if (chapters.length > 0 && chaptersFormCleanTimeline(chapters, duration)) {
    return rescaleByChapters(scenes, chapters);
  }

  return globalRescale(scenes, duration);
}

/**
 * True iff scenes are usable as-is: first starts at 0 (within tolerance),
 * last ends at duration (within tolerance), every scene has positive
 * duration, and consecutive scenes are contiguous. Used as the "no-op"
 * gate on the rescale.
 */
function scenesFormCleanTimeline(scenes: AnalyzedScene[], duration: number): boolean {
  if (Math.abs(scenes[0].start - 0) > SCENE_DURATION_TOLERANCE_SECONDS) return false;
  if (Math.abs(scenes[scenes.length - 1].end - duration) > SCENE_DURATION_TOLERANCE_SECONDS) return false;
  for (const s of scenes) {
    if (s.end < s.start) return false;
    if (s.end > duration + SCENE_DURATION_TOLERANCE_SECONDS) return false;
  }
  for (let i = 1; i < scenes.length; i++) {
    const gap = scenes[i].start - scenes[i - 1].end;
    if (Math.abs(gap) > SCENE_OVERLAP_TOLERANCE_SECONDS) return false;
  }
  return true;
}

/**
 * True iff chapters are trustworthy as an anchor for scene rescaling.
 * Same shape rules as scenes plus a tighter end-within-duration check:
 * a single chapter overflowing makes the whole chapter list unsafe to
 * use as an anchor.
 */
function chaptersFormCleanTimeline(
  chapters: ReadonlyArray<{ start: number; end: number }>,
  duration: number,
): boolean {
  if (Math.abs(chapters[0].start - 0) > SCENE_DURATION_TOLERANCE_SECONDS) return false;
  if (Math.abs(chapters[chapters.length - 1].end - duration) > SCENE_DURATION_TOLERANCE_SECONDS) return false;
  for (const c of chapters) {
    if (c.end < c.start) return false;
    if (c.end > duration + SCENE_DURATION_TOLERANCE_SECONDS) return false;
  }
  for (let i = 1; i < chapters.length; i++) {
    const gap = chapters[i].start - chapters[i - 1].end;
    if (Math.abs(gap) > SCENE_OVERLAP_TOLERANCE_SECONDS) return false;
  }
  return true;
}

function rescaleByChapters(
  scenes: AnalyzedScene[],
  chapters: ReadonlyArray<{ start: number; end: number }>,
): { scenes: AnalyzedScene[]; warnings: string[] } {
  // Group scenes by chapter via scene.start. Because scenes claim to
  // be contiguous (scene[i].start ≈ scene[i-1].end), walking them in
  // order and assigning to the first chapter whose end exceeds
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

/**
 * Fallback path for when chapters can't be used as anchors. Sums all
 * positive scene durations (treating negative-duration scenes as
 * zero-length, since Gemini's own arithmetic is broken in that case),
 * then proportionally rescales the whole list to fit
 * `duration_seconds`. The result is always a clean timeline starting
 * at 0 and ending at duration_seconds, with each scene's relative
 * proportion preserved against the sum of POSITIVE claimed durations.
 */
function globalRescale(
  scenes: AnalyzedScene[],
  duration: number,
): { scenes: AnalyzedScene[]; warnings: string[] } {
  const positiveDurations = scenes.map((s) => Math.max(0, s.end - s.start));
  const sum = positiveDurations.reduce((acc, d) => acc + d, 0);
  if (sum < 0.001) {
    // Every claimed duration was non-positive — distribute scenes
    // uniformly as a last-resort fallback.
    const equalSlice = duration / scenes.length;
    return {
      scenes: scenes.map((s, i) => ({
        ...s,
        start: round1(i * equalSlice),
        end: round1(i === scenes.length - 1 ? duration : (i + 1) * equalSlice),
      })),
      warnings: [
        `scenes globally rescaled (uniform fallback): ${scenes.length} scenes had no positive durations; distributed uniformly across ${duration}s`,
      ],
    };
  }

  const scale = duration / sum;
  let cursor = 0;
  const out = scenes.map((s, i) => {
    const newStart = cursor;
    cursor += positiveDurations[i] * scale;
    const newEnd = i === scenes.length - 1 ? duration : cursor;
    return { ...s, start: round1(newStart), end: round1(newEnd) };
  });
  return {
    scenes: out,
    warnings: [
      `scenes globally rescaled: ${scenes.length} scenes' positive durations summed to ${sum.toFixed(1)}s, scaled to fit duration ${duration}s (×${scale.toFixed(3)}); chapters were not trustworthy as an anchor`,
    ],
  };
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

  // Per-scene validity. Gemini was observed emitting scenes where end <
  // start (negative duration) when it partially obeyed rule #12 by
  // clamping the LAST scene's end to duration_seconds but leaving the
  // start at its hallucinated value — see the v1.5.0 Casey re-run.
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (s.end < s.start) {
      out.push(`scenes[${i}]: negative duration (start=${s.start}s, end=${s.end}s)`);
    }
    if (s.end > duration + SCENE_DURATION_TOLERANCE_SECONDS) {
      out.push(`scenes[${i}].end: ${s.end}s overflows meta.duration_seconds=${duration}s`);
    }
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

  // Per-chapter validity — same defect family as the scene check.
  // Gemini's v1.5.0 Casey re-run produced chapter 6 with start > end.
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c.end < c.start) {
      out.push(`chapters[${i}]: negative duration (start=${c.start}s, end=${c.end}s)`);
    }
    if (c.end > duration + SCENE_DURATION_TOLERANCE_SECONDS) {
      out.push(`chapters[${i}].end: ${c.end}s overflows meta.duration_seconds=${duration}s`);
    }
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
