/**
 * Pure helpers for the doodle_explainer_2 motion_collage renderer.
 *
 * MotionCollageScene takes N pre-sliced panel images and plays them
 * hard-cut across the shot's duration. The frame-math is small but
 * load-bearing — get it wrong and either (a) the total panel duration
 * undershoots the shot window (a blank tail) OR (b) overshoots it
 * (Remotion clips the last panel). Pulled into a pure helper so the
 * arithmetic can be tested without mounting a React tree.
 *
 * See _plans/2026-05-31-doodle-explainer-2-motion-collage.md.
 */

/** One Remotion `<Sequence>` window: where the panel starts (frame
 *  offset from shot start) and how many frames it occupies. */
export interface MotionCollagePanelWindow {
  /** Frame offset from shot start. */
  from: number;
  /** Frames this panel occupies. Never negative. May be zero when the
   *  shot is too short for the requested panel count — the renderer
   *  defensively skips zero-frame panels so Remotion doesn't error at
   *  compose time, but the pipeline's `min_per_frame_ms` setting is
   *  the canonical guard against this case landing in the renderer. */
  durationInFrames: number;
}

/**
 * Divide a shot's `durationInFrames` evenly across `panelCount`
 * panels, with the remainder absorbed by the LAST panel. The total
 * of every returned window's `durationInFrames` equals the input
 * `durationInFrames` exactly when `panelCount > 0`.
 *
 * Edge cases:
 *   - `panelCount <= 0` → returns `[]` (caller renders the fallback
 *     single-image path).
 *   - `durationInFrames <= 0` → returns `panelCount` windows of
 *     `{from: 0, durationInFrames: 0}` (defensive — pipeline's
 *     `min_per_frame_ms` gate prevents this in normal flow).
 *   - `panelCount > durationInFrames` → early panels each get 0 frames;
 *     last panel absorbs the whole window. Documented but unusual.
 */
export function planMotionCollageWindows(
  durationInFrames: number,
  panelCount: number,
): MotionCollagePanelWindow[] {
  if (!Number.isInteger(panelCount) || panelCount <= 0) return [];
  if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) {
    return Array.from({ length: panelCount }, () => ({ from: 0, durationInFrames: 0 }));
  }
  const panelFrames = Math.floor(durationInFrames / panelCount);
  const remainder = durationInFrames - panelFrames * panelCount;
  const windows: MotionCollagePanelWindow[] = [];
  for (let i = 0; i < panelCount; i++) {
    windows.push({
      from: i * panelFrames,
      durationInFrames: i === panelCount - 1 ? panelFrames + remainder : panelFrames,
    });
  }
  return windows;
}
