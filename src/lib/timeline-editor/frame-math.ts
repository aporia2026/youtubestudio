/**
 * Frame-accurate time conversions for the CapCut-style timeline
 * editor. The underlying library (`@xzdarcy/react-timeline-editor`)
 * exposes time as a float `seconds` value. CapCut feels right because
 * every drag, every trim, every split snaps to a frame boundary.
 *
 * All conversions go through this file so the rest of the editor
 * can stay fps-agnostic. Default fps is 30 (matches the existing
 * Remotion compositions).
 */

export const DEFAULT_FPS = 30;
export const MIN_FPS = 12;
export const MAX_FPS = 120;

/** ms → seconds (used by the library's API). */
export function msToSec(ms: number): number {
  return ms / 1000;
}

/** seconds (library) → ms (our ProductionRow shape). */
export function secToMs(sec: number): number {
  return sec * 1000;
}

/** ms → number of frames at the supplied fps. May be fractional —
 *  callers usually pair this with `Math.round` before re-converting. */
export function msToFrames(ms: number, fps: number = DEFAULT_FPS): number {
  return (ms * fps) / 1000;
}

/** frames → ms, exact at fps where 1000 is divisible. At 30 fps
 *  one frame is 33.333… ms, so we return float; the caller can
 *  round to the nearest integer ms before persistence. */
export function framesToMs(frames: number, fps: number = DEFAULT_FPS): number {
  return (frames * 1000) / fps;
}

/** seconds → number of frames. */
export function secToFrames(sec: number, fps: number = DEFAULT_FPS): number {
  return sec * fps;
}

/** frames → seconds. */
export function framesToSec(frames: number, fps: number = DEFAULT_FPS): number {
  return frames / fps;
}

/** Snap a millisecond value to the nearest frame boundary. */
export function snapMsToFrame(ms: number, fps: number = DEFAULT_FPS): number {
  return framesToMs(Math.round(msToFrames(ms, fps)), fps);
}

/** Snap a seconds value to the nearest frame boundary. */
export function snapSecToFrame(sec: number, fps: number = DEFAULT_FPS): number {
  return framesToSec(Math.round(secToFrames(sec, fps)), fps);
}

/** Validate an fps value is within a sane range. Throws on
 *  out-of-range — call sites that accept user input should pre-clamp. */
export function assertFps(fps: number): void {
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    throw new Error(`fps must be in [${MIN_FPS}, ${MAX_FPS}], got ${fps}`);
  }
}
