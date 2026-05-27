/**
 * Pure conversions between Remotion frame numbers and `(rowIndex, ms
 * within scene)` tuples — the coordinate space the notes feature uses
 * to pin a note to a specific moment in a specific scene.
 *
 * Lives in `src/lib/notes/` rather than the renderer because the notes
 * UI is the only caller; keeping it here means the math is testable
 * without dragging the whole Remotion composition module graph.
 */

import type { VideoShot } from '@/remotion/types';

/** Find the shot whose [startMs, startMs+durationMs) interval contains
 *  `tsMs`. Returns null when the timestamp is before the first shot or
 *  after the last shot's end (defensive — should not happen during
 *  normal playback inside the configured duration).
 *
 *  The shot list is short (typically 20–200 shots per doc), so a linear
 *  scan is fine. The `≤ startMs` branch on the lower end keeps a click
 *  exactly on a scene boundary landing on the new scene (matches the
 *  Player's own boundary semantics). */
export function shotIndexAtMs(shots: VideoShot[], tsMs: number): number | null {
  if (shots.length === 0) return null;
  if (tsMs < shots[0].startMs) return null;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const end = shot.startMs + shot.durationMs;
    if (tsMs < end) return i;
  }
  return shots.length - 1;
}

/** Frame number → `(rowIndex, msWithinScene)`. Returns null when the
 *  frame doesn't fall inside any shot. */
export function frameToScenePin(
  shots: VideoShot[],
  fps: number,
  frame: number,
): { rowIndex: number; sceneTsMs: number } | null {
  if (fps <= 0) return null;
  const tsMs = Math.round((frame / fps) * 1000);
  const rowIndex = shotIndexAtMs(shots, tsMs);
  if (rowIndex == null) return null;
  const offset = Math.max(0, tsMs - shots[rowIndex].startMs);
  return { rowIndex, sceneTsMs: offset };
}

/** Inverse: `(rowIndex, msWithinScene)` → absolute frame. Used by the
 *  review queue's "jump to this note" action. Clamps offsets that
 *  overshoot the scene's duration so a stale note from before a
 *  duration change still lands inside the right scene. */
export function scenePinToFrame(
  shots: VideoShot[],
  fps: number,
  rowIndex: number,
  sceneTsMs: number,
): number | null {
  if (fps <= 0) return null;
  if (rowIndex < 0 || rowIndex >= shots.length) return null;
  const shot = shots[rowIndex];
  const clampedOffset = Math.max(0, Math.min(sceneTsMs, shot.durationMs - 1));
  const absMs = shot.startMs + clampedOffset;
  return Math.floor((absMs / 1000) * fps);
}

/** Format a ms-within-scene as a compact `m:ss.t` for UI labels. Used
 *  in the dock and the review queue ("scene 4 @ 2.3s"). */
export function formatSceneTs(sceneTsMs: number): string {
  if (sceneTsMs < 0 || !Number.isFinite(sceneTsMs)) return '0.0s';
  const seconds = sceneTsMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
