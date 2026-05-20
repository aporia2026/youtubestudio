/**
 * Ken Burns motion compiler — pure math, no ffmpeg, no disk.
 *
 * Turns a `KenBurnsRecipe` plus the source image dimensions into the
 * `zoompan` filter expression ffmpeg uses to animate the still. The
 * expression is a single string the executor pastes into its
 * `-filter_complex` argument.
 *
 * Pure on purpose: every motion bug should be reproducible from a
 * unit test by passing a recipe and asserting on the generated
 * expression string. No side effects.
 *
 * Phase 1 of `_plans/2026-05-20-ffmpeg-native-renderer.md`.
 *
 * ─── About ffmpeg's zoompan ─────────────────────────────────────────
 *
 * zoompan takes per-frame expressions for `zoom`, `x`, `y`, plus
 * a fixed output `s=WxH` and frame count `d`. The expressions can
 * reference:
 *   - `on` — output frame index (starts at 0)
 *   - `iw` / `ih` — source image dimensions
 *   - `pzoom` / `px` / `py` — previous frame's resolved values
 *
 * We use a constant-velocity interpolation over the scene duration:
 *   t       = on / (totalFrames - 1)          ∈ [0, 1]
 *   zoom(t) = startZoom + (endZoom-startZoom) * t
 *   cx(t)   = startCx   + (endCx-startCx)     * t
 *   cy(t)   = startCy   + (endCy-startCy)     * t
 *
 * Then translate (cx, cy) — which are image-relative center points —
 * into the `x`/`y` zoompan expects (image-relative top-left of the
 * visible window):
 *   x(t) = cx(t)*iw - iw/(2*zoom(t))
 *   y(t) = cy(t)*ih - ih/(2*zoom(t))
 *
 * That's the whole motion. The bug surface is in the boundary cases
 * (totalFrames=1 → divide by zero) and in keeping the floating-point
 * format ffmpeg-friendly (no scientific notation, sane precision).
 */

import type { KenBurnsRecipe } from './types';

/** Bounds we trust the math at. Anything outside gets clamped at
 *  compile time — defends against a corrupt config producing a NaN
 *  zoom that crashes ffmpeg. */
const ZOOM_BOUNDS = { min: 1.0, max: 2.0 } as const;
const CENTER_BOUNDS = { min: 0.0, max: 1.0 } as const;

function clamp(v: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(v)) return bounds.min;
  return Math.max(bounds.min, Math.min(bounds.max, v));
}

/**
 * Format a float so ffmpeg's expression parser accepts it. Avoid
 * scientific notation (1e-7 → '0.0000001'). Six decimal places is
 * enough precision for 1080p Ken Burns; more bloats the command line
 * for no visible difference.
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export interface KenBurnsZoompanExpressions {
  /** `z=` expression in zoompan syntax. */
  z: string;
  /** `x=` expression. */
  x: string;
  /** `y=` expression. */
  y: string;
  /** `d=` frame count. */
  d: number;
  /** `s=WxH` output size. */
  s: string;
}

export interface BuildKenBurnsArgs {
  recipe: KenBurnsRecipe;
  /** Total output frames (durationMs * fps / 1000, rounded). */
  totalFrames: number;
  /** Output canvas width in pixels. */
  canvasWidth: number;
  /** Output canvas height in pixels. */
  canvasHeight: number;
}

/**
 * Build the zoompan expressions for a Ken Burns motion.
 *
 * - `recipe.kind === 'none'` → static still at zoom=1, centered.
 * - `recipe.kind === 'pan-zoom'` → constant-velocity interpolation
 *   from start framing to end framing.
 *
 * Always returns valid expressions. Bad input is clamped, never thrown.
 */
export function buildKenBurnsZoompan(args: BuildKenBurnsArgs): KenBurnsZoompanExpressions {
  const { recipe, totalFrames, canvasWidth, canvasHeight } = args;
  // Guard against degenerate scene durations. zoompan with d=1 still
  // requires a divisor we can compute; clamp to at least 2 so the
  // `(totalFrames - 1)` denominator stays nonzero.
  const frames = Math.max(2, Math.round(totalFrames));
  const s = `${canvasWidth}x${canvasHeight}`;

  if (recipe.kind === 'none') {
    return {
      z: '1.0',
      // Center the window: x = iw/2 - iw/(2*1) = 0; y = ih/2 - ih/(2*1) = 0
      x: '0',
      y: '0',
      d: frames,
      s,
    };
  }

  const startZoom = clamp(recipe.startZoom, ZOOM_BOUNDS);
  const endZoom = clamp(recipe.endZoom, ZOOM_BOUNDS);
  const startCx = clamp(recipe.startCx, CENTER_BOUNDS);
  const startCy = clamp(recipe.startCy, CENTER_BOUNDS);
  const endCx = clamp(recipe.endCx, CENTER_BOUNDS);
  const endCy = clamp(recipe.endCy, CENTER_BOUNDS);

  // t = on / (frames - 1) — normalized progress in [0, 1].
  const tExpr = `(on/${fmt(frames - 1)})`;

  // zoom(t) = startZoom + (endZoom - startZoom) * t
  const z =
    startZoom === endZoom
      ? fmt(startZoom)
      : `(${fmt(startZoom)}+(${fmt(endZoom - startZoom)})*${tExpr})`;

  // cx(t), cy(t) — image-relative center over time.
  const cx =
    startCx === endCx
      ? fmt(startCx)
      : `(${fmt(startCx)}+(${fmt(endCx - startCx)})*${tExpr})`;
  const cy =
    startCy === endCy
      ? fmt(startCy)
      : `(${fmt(startCy)}+(${fmt(endCy - startCy)})*${tExpr})`;

  // Convert center → top-left in zoompan's coordinate system.
  // x = cx*iw - iw/(2*z) → iw*(cx - 1/(2*z))
  // y analogously for the height axis.
  const x = `iw*(${cx}-1/(2*${z}))`;
  const y = `ih*(${cy}-1/(2*${z}))`;

  return { z, x, y, d: frames, s };
}

/**
 * Standard, deterministic Ken Burns presets keyed by direction string
 * (matching `VideoShot.kenBurnsDirection`). Each preset returns a
 * `KenBurnsRecipe` with sensible start/end framings. The motion is
 * subtle (1.0 → 1.15 zoom, ~10% pan) so it reads as "alive" without
 * making the viewer notice the camera.
 *
 * Direction names map to motion:
 *   - 'zoom-in'  : start at zoom 1.0 centered, end at zoom 1.15 centered
 *   - 'zoom-out' : the reverse
 *   - 'pan-left' / 'pan-right' / 'pan-up' / 'pan-down' :
 *       zoom held at 1.1, center shifts ~10% along the axis
 *
 * Unknown direction falls through to a centered zoom-in.
 */
export function recipeForDirection(
  direction:
    | 'zoom-in'
    | 'zoom-out'
    | 'pan-left'
    | 'pan-right'
    | 'pan-up'
    | 'pan-down'
    | undefined,
): KenBurnsRecipe {
  switch (direction) {
    case 'zoom-out':
      return { kind: 'pan-zoom', startZoom: 1.15, endZoom: 1.0, startCx: 0.5, startCy: 0.5, endCx: 0.5, endCy: 0.5 };
    case 'pan-left':
      return { kind: 'pan-zoom', startZoom: 1.1, endZoom: 1.1, startCx: 0.55, startCy: 0.5, endCx: 0.45, endCy: 0.5 };
    case 'pan-right':
      return { kind: 'pan-zoom', startZoom: 1.1, endZoom: 1.1, startCx: 0.45, startCy: 0.5, endCx: 0.55, endCy: 0.5 };
    case 'pan-up':
      return { kind: 'pan-zoom', startZoom: 1.1, endZoom: 1.1, startCx: 0.5, startCy: 0.55, endCx: 0.5, endCy: 0.45 };
    case 'pan-down':
      return { kind: 'pan-zoom', startZoom: 1.1, endZoom: 1.1, startCx: 0.5, startCy: 0.45, endCx: 0.5, endCy: 0.55 };
    case 'zoom-in':
    default:
      return { kind: 'pan-zoom', startZoom: 1.0, endZoom: 1.15, startCx: 0.5, startCy: 0.5, endCx: 0.5, endCy: 0.5 };
  }
}
