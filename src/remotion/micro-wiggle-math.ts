/**
 * MicroWiggle math — pure helper for the ambient ±1° / ±2 px
 * transform the paint_explainer_v1 `micro_wiggle` motion beat
 * applies to the character base layer.
 *
 * Why pure: Lambda renders and preview renders both call this with
 * the same (frame, fps) inputs and MUST produce byte-identical
 * transforms — otherwise the character "jumps" between the preview
 * and the rendered MP4. Deterministic sin/cos (no Math.random / no
 * frame-time / no Perlin seed state) gives that guarantee for free.
 *
 * Plan: §4 (Layer 1 — MicroWiggle) of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */

/** Sensible defaults — tuned to read as "subtle aliveness" on a
 *  centered close-up character, not "shaky-cam motion sickness."
 *  The reference videos use roughly this amount of ambient motion
 *  on held character poses between scripted gestures. */
export const MICRO_WIGGLE_DEFAULTS = {
  rotationDeg: 1.0,
  translatePx: 2,
  rotationFreqHz: 0.6,
  translateFreqHz: 0.8,
} as const;

export interface MicroWiggleOpts {
  /** Peak rotation magnitude in degrees. Output rotates between
   *  -rotationDeg and +rotationDeg as a sine wave at rotationFreqHz.
   *  Default 1.0 deg. */
  rotationDeg?: number;
  /** Peak translation magnitude in pixels. Translates between
   *  -translatePx and +translatePx on both X and Y, with the X and
   *  Y waves running at slightly different frequencies so they
   *  don't reinforce into a single linear bob. Default 2 px. */
  translatePx?: number;
  /** Rotation oscillation frequency in Hz. Default 0.6 Hz (one full
   *  rotation cycle ~1.67 s — slow enough to read as breathing,
   *  fast enough to register as life). */
  rotationFreqHz?: number;
  /** Translation oscillation frequency in Hz. Default 0.8 Hz —
   *  intentionally different from rotation so the two motions
   *  don't quantise into a single cyclical sway. */
  translateFreqHz?: number;
}

export interface MicroWiggleTransform {
  /** Degrees, signed. */
  rotation: number;
  /** Pixels, signed. */
  translateX: number;
  translateY: number;
}

/** Compute the wiggle transform for a given (frame, fps).
 *
 *  Frame-deterministic: the same (frame, fps, opts) always returns
 *  the same transform — preview and Lambda renders stay in sync.
 *
 *  All three axes (rotation, translateX, translateY) use sine waves
 *  with relatively-prime-ish frequencies so the visible motion
 *  reads as "small natural sway" rather than "rocking on a single
 *  axis."
 *
 *  Defensive against bad inputs: zero / negative fps falls back to
 *  the canonical 30 fps so the function never divides by zero, and
 *  callers that forget to forward a fps just get a sensible-looking
 *  wiggle instead of a NaN-pocked transform. */
export function microWiggleTransform(
  frame: number,
  fps: number,
  opts?: MicroWiggleOpts,
): MicroWiggleTransform {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const tSec = frame / safeFps;

  const rotationDeg = opts?.rotationDeg ?? MICRO_WIGGLE_DEFAULTS.rotationDeg;
  const translatePx = opts?.translatePx ?? MICRO_WIGGLE_DEFAULTS.translatePx;
  const rotationFreqHz = opts?.rotationFreqHz ?? MICRO_WIGGLE_DEFAULTS.rotationFreqHz;
  const translateFreqHz = opts?.translateFreqHz ?? MICRO_WIGGLE_DEFAULTS.translateFreqHz;

  // Rotation: one sine wave at rotationFreqHz.
  const rotation = rotationDeg * Math.sin(2 * Math.PI * rotationFreqHz * tSec);

  // X and Y translation: two sine waves at translateFreqHz, with a
  // 90° phase offset on Y so the two axes are uncorrelated. The
  // result reads as a small elliptical sway rather than a diagonal
  // back-and-forth.
  const translateX = translatePx * Math.sin(2 * Math.PI * translateFreqHz * tSec);
  const translateY = translatePx * Math.sin(2 * Math.PI * translateFreqHz * tSec + Math.PI / 2);

  return { rotation, translateX, translateY };
}

/** Convenience: build a CSS transform string from a wiggle transform.
 *  Exported separately so callers can compose with other transforms
 *  (e.g. a wrapping scale) without having to re-derive the format. */
export function microWiggleCssTransform(transform: MicroWiggleTransform): string {
  return `rotate(${transform.rotation.toFixed(4)}deg) translate(${transform.translateX.toFixed(4)}px, ${transform.translateY.toFixed(4)}px)`;
}
