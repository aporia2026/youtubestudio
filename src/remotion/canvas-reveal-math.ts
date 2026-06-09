/**
 * Pure math for zenn_v1 canvas_reveal layers. No React, no Remotion
 * imports — this module is safe to import from anywhere (renderer,
 * tests, pipeline scaffolding). Keeps the reveal-frame math in one
 * place so a regression that breaks Sequence windowing is caught at
 * the test level rather than visually at the render step.
 *
 * Beat semantics (plan §4.2):
 *   - `canvas_reveal`     — sibling-frame PNG cross-fades in over
 *                           `fade_in_ms` from `reveal_at_ms`, then
 *                           stays visible at full opacity for
 *                           `duration_ms` (or until end of shot).
 *   - `canvas_layer_add`  — same as canvas_reveal but with
 *                           `fade_in_ms = 0` (instant appear).
 *
 * Both beats share one schema; the renderer reads
 * `revealLayerOpacityAt` once per frame to drive the layer's
 * opacity, and `resolveRevealWindow` once per layer to position the
 * Sequence window inside the shot.
 *
 * Defaults match the architecture plan §5.5: `fade_in_ms = 250 ms`
 * when absent (the canvas_reveal default), `duration_ms` extends to
 * the end of the shot when absent.
 */

/** Default cross-fade window for canvas_reveal layers. Set on every
 *  layer that doesn't specify `fade_in_ms` explicitly. */
export const DEFAULT_CANVAS_REVEAL_FADE_IN_MS = 250;

/** Input shape mirrors `ProductionRow.zenn_canvas_reveal_layers` and
 *  `VideoShot.zennCanvasRevealLayers`. Restated here so the helpers
 *  don't drag the full doc / shot types into this pure module. */
export interface CanvasRevealLayerInput {
  prompt_hint?: string;
  image_url?: string;
  reveal_at_ms: number;
  duration_ms?: number;
  fade_in_ms?: number;
}

/** Resolved Sequence window + fade for a single canvas_reveal layer.
 *  The renderer feeds `fromFrame` + `durationFrames` straight into
 *  `<Sequence from durationInFrames>` and uses `fadeFrames` as the
 *  opacity ramp length. */
export interface ResolvedCanvasRevealWindow {
  /** Frame the layer's `<Sequence>` starts at, relative to shot start. */
  fromFrame: number;
  /** Number of frames the `<Sequence>` stays mounted. Clamped so a
   *  layer scheduled past the end of the shot doesn't render. */
  durationFrames: number;
  /** Number of frames opacity ramps from 0 → 1 (counted from
   *  `fromFrame`). `0` means instant appear (canvas_layer_add). */
  fadeFrames: number;
}

/** Convert ms to whole frames at a given fps. Rounds to nearest so a
 *  layer scheduled at 333 ms doesn't drift to frame 7 (28 ms early)
 *  or frame 9 (37 ms late) — at 24 fps the nearest frame is 8 (333 ms
 *  exactly). Kept private to this module; callers pass ms in and
 *  receive frames out. */
function msToFrameRounded(ms: number, fps: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.round((ms / 1000) * fps);
}

/** Resolve the Sequence window + fade duration for a canvas_reveal
 *  layer inside a shot of length `shotDurationMs` rendering at
 *  `fps`. Clamps every value defensively so a malformed entry (NaN,
 *  negative, past the shot end, fade longer than the layer) cannot
 *  produce a broken `<Sequence>` or a NaN opacity.
 *
 *  Behavior:
 *    - `reveal_at_ms` clamped to `[0, shotDurationMs]`.
 *    - `duration_ms` absent OR larger than the remaining shot:
 *      clamped to the remaining shot duration.
 *    - `fade_in_ms` absent: defaults to
 *      `DEFAULT_CANVAS_REVEAL_FADE_IN_MS`.
 *    - `fade_in_ms` larger than the layer's `durationFrames`: clamped
 *      to `durationFrames` so the ramp completes inside the layer.
 *
 *  Pure: no IO. Safe to call from server and renderer. */
export function resolveRevealWindow(
  layer: CanvasRevealLayerInput,
  shotDurationMs: number,
  fps: number,
): ResolvedCanvasRevealWindow {
  const shotMs = Math.max(0, Number.isFinite(shotDurationMs) ? shotDurationMs : 0);
  const revealMs = Math.max(0, Math.min(layer.reveal_at_ms ?? 0, shotMs));
  const remainMs = Math.max(0, shotMs - revealMs);
  const requestedDurationMs =
    typeof layer.duration_ms === 'number' && Number.isFinite(layer.duration_ms) && layer.duration_ms > 0
      ? layer.duration_ms
      : remainMs;
  const durationMs = Math.max(0, Math.min(requestedDurationMs, remainMs));
  const fadeMs =
    typeof layer.fade_in_ms === 'number' && Number.isFinite(layer.fade_in_ms) && layer.fade_in_ms >= 0
      ? layer.fade_in_ms
      : DEFAULT_CANVAS_REVEAL_FADE_IN_MS;

  const fromFrame = msToFrameRounded(revealMs, fps);
  const durationFrames = msToFrameRounded(durationMs, fps);
  // Cap the fade at the total layer duration. Without this, a 250 ms
  // default fade on a 100 ms layer would never reach full opacity —
  // the layer would render at < 50 % opacity for its entire life.
  const fadeFrames = Math.min(msToFrameRounded(fadeMs, fps), durationFrames);

  return { fromFrame, durationFrames, fadeFrames };
}

/** Compute the opacity for a canvas_reveal layer at frame `localFrame`,
 *  where `localFrame` is the frame index INSIDE the layer's Sequence
 *  (frame 0 = reveal start). Linear ramp from 0 → 1 over `fadeFrames`,
 *  then held at 1.
 *
 *  Special case: `fadeFrames <= 0` returns 1 immediately (the
 *  canvas_layer_add semantics — the layer pops in at frame 0 with no
 *  ramp). This is the LLM's escape hatch for snappy "thing appears"
 *  cuts vs. the slower default cross-fade.
 *
 *  Pure: no IO. Safe to call inside a Remotion frame loop. */
export function revealLayerOpacityAt(localFrame: number, fadeFrames: number): number {
  if (!Number.isFinite(fadeFrames) || fadeFrames <= 0) return 1;
  if (!Number.isFinite(localFrame) || localFrame <= 0) return 0;
  if (localFrame >= fadeFrames) return 1;
  return localFrame / fadeFrames;
}

/** True when a canvas_reveal layer is ready for the renderer to mount
 *  — it has a non-empty `image_url`. Layers pending pipeline
 *  generation (prompt_hint set, image_url unset) return false; the
 *  renderer skips them silently per plan §5.3. Pure. */
export function isRevealLayerRenderable(
  layer: CanvasRevealLayerInput | undefined | null,
): layer is CanvasRevealLayerInput & { image_url: string } {
  return Boolean(layer?.image_url && layer.image_url.trim().length > 0);
}
