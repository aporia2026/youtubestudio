/**
 * Pure helper for comparing two `AnalyzedVideo` outputs of the same
 * video — used by the eval driver's stability mode and any future
 * "did re-analyze actually change anything material?" checks.
 *
 * The diff intentionally focuses on load-bearing structural fields
 * (pack count, pack ids, scene count, duration agreement, per-pack
 * prompt-suffix length). It does NOT do semantic comparison of free-
 * text fields — that would need an LLM-on-LLM judge, out of scope
 * for a deterministic pure helper. The goal is "did Gemini make
 * categorically different decisions between runs?", not "is the prose
 * identical?"
 *
 * No side effects. No I/O. Pure function over its inputs.
 */

import type { AnalyzedVideo } from './types';

export interface AnalysisDiff {
  packCountA: number;
  packCountB: number;
  packIdsOnlyInA: string[];
  packIdsOnlyInB: string[];
  packIdsInBoth: string[];
  sceneCountA: number;
  sceneCountB: number;
  durationSecondsA: number;
  durationSecondsB: number;
  /**
   * Per-shared-pack-id: how many characters the `suggested_ai_image_suffix`
   * differs by in absolute length. A coarse proxy for "did the prompt
   * change materially?" — useful for the stability check but not a
   * substitute for human comparison of the actual suffix text.
   */
  suffixLengthDeltas: Array<{ packId: string; lengthA: number; lengthB: number; delta: number }>;
  /**
   * Whether the two analyses pass a "structurally stable" sniff test:
   * same pack count, same pack-id set, same duration_seconds, scene
   * count within ±25%. False does not mean either run is wrong —
   * it means an operator who treats the two as equivalent is making
   * an assumption Gemini didn't actually confirm.
   */
  structurallyStable: boolean;
}

export function compareAnalyses(a: AnalyzedVideo, b: AnalyzedVideo): AnalysisDiff {
  const idsA = new Set(a.style_packs.map((p) => p.id));
  const idsB = new Set(b.style_packs.map((p) => p.id));
  const onlyA = Array.from(idsA).filter((id) => !idsB.has(id)).sort();
  const onlyB = Array.from(idsB).filter((id) => !idsA.has(id)).sort();
  const inBoth = Array.from(idsA).filter((id) => idsB.has(id)).sort();

  const suffixLengthDeltas = inBoth.map((packId) => {
    const lengthA = a.style_packs.find((p) => p.id === packId)?.suggested_ai_image_suffix.length ?? 0;
    const lengthB = b.style_packs.find((p) => p.id === packId)?.suggested_ai_image_suffix.length ?? 0;
    return { packId, lengthA, lengthB, delta: Math.abs(lengthA - lengthB) };
  });

  const sameDuration = a.meta.duration_seconds === b.meta.duration_seconds;
  const samePackCount = a.style_packs.length === b.style_packs.length;
  const samePackIds = onlyA.length === 0 && onlyB.length === 0;
  const sceneCountRatio =
    Math.max(a.scenes.length, b.scenes.length) === 0
      ? 1
      : Math.min(a.scenes.length, b.scenes.length) / Math.max(a.scenes.length, b.scenes.length);
  const sceneCountClose = sceneCountRatio >= 0.75;

  return {
    packCountA: a.style_packs.length,
    packCountB: b.style_packs.length,
    packIdsOnlyInA: onlyA,
    packIdsOnlyInB: onlyB,
    packIdsInBoth: inBoth,
    sceneCountA: a.scenes.length,
    sceneCountB: b.scenes.length,
    durationSecondsA: a.meta.duration_seconds,
    durationSecondsB: b.meta.duration_seconds,
    suffixLengthDeltas,
    structurallyStable: sameDuration && samePackCount && samePackIds && sceneCountClose,
  };
}

/**
 * Convenience compactor for log lines / summary.json output: turns a
 * full diff into a one-line headline describing how stable the pair
 * was. Used by the eval driver's stability mode.
 */
export function summarizeDiff(diff: AnalysisDiff): string {
  if (diff.structurallyStable) {
    return `STABLE: ${diff.packCountA} packs (${diff.packIdsInBoth.join(', ')}), scene count ${diff.sceneCountA}/${diff.sceneCountB}`;
  }
  const reasons: string[] = [];
  if (diff.packCountA !== diff.packCountB) reasons.push(`pack count ${diff.packCountA}≠${diff.packCountB}`);
  if (diff.packIdsOnlyInA.length > 0) reasons.push(`A-only: ${diff.packIdsOnlyInA.join(',')}`);
  if (diff.packIdsOnlyInB.length > 0) reasons.push(`B-only: ${diff.packIdsOnlyInB.join(',')}`);
  if (diff.durationSecondsA !== diff.durationSecondsB) reasons.push(`duration ${diff.durationSecondsA}≠${diff.durationSecondsB}`);
  if (Math.max(diff.sceneCountA, diff.sceneCountB) > 0) {
    const ratio = Math.min(diff.sceneCountA, diff.sceneCountB) / Math.max(diff.sceneCountA, diff.sceneCountB);
    if (ratio < 0.75) reasons.push(`scene count ${diff.sceneCountA}/${diff.sceneCountB} (>25% drift)`);
  }
  return `UNSTABLE: ${reasons.join('; ')}`;
}
