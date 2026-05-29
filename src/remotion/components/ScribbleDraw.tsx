/**
 * ScribbleDraw — paint_explainer_v1 "drawing in progress" reveal.
 *
 * Visually: the base image appears as if it's being drawn — lines
 * progressively materialise from left to right (default), top to
 * bottom, or radially out from center. The illusion is what the Paint
 * Explainer reference uses whenever a new scene "lands" on screen:
 * the doodle isn't fading in or sliding in; it's drawn in.
 *
 * ─── Architecture: cover-and-reveal, NOT stroke-by-stroke ──────────
 * The plan §4 sketched two options for this primitive: an Atlas-
 * generated SVG trace of the base (animate `stroke-dasharray` per
 * path) OR a multi-stage AI generation (under-draw → ink → final,
 * crossfaded). Both add real cost (vectorisation pipeline OR 3× per
 * base) for an unproven quality lift over the simpler approach below.
 *
 * What ships here instead: an absolute-fill white cover that
 * progressively masks AWAY using a soft-edged CSS gradient. The base
 * image lives in the layer beneath. As the cover's mask grows from
 * 0% transparency to 100% transparency along the chosen direction,
 * the doodle beneath appears. Result: same "lines appearing over
 * time" visual contract — zero new AI calls, zero new pipelines.
 *
 * If SVG-trace quality later proves to be meaningfully better, this
 * component swaps for an SVG-path variant in a single PR — the
 * MotionScene wiring stays identical because the prop contract
 * (baseUrl + durationInFrames + direction) is generic to either
 * implementation.
 *
 * ─── How to mount ────────────────────────────────────────────────────
 * Wrap in a Remotion `<Sequence>` for the beat's window — the
 * Sequence's `from` controls when the reveal starts, `durationInFrames`
 * controls how long the reveal takes. The component itself uses
 * `useCurrentFrame()` which is rebased to 0 at the Sequence start.
 *
 * Layer order inside MotionScene:
 *   - Behind: base image (mouth-removed or otherwise).
 *   - ScribbleDraw: white cover that recedes.
 *   - In front: label-pop, real-photo punch-in, mouth-swap.
 *
 * Plan: §4 (Layer 1) + §16 (open question 1) of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export type ScribbleDrawDirection = 'left-to-right' | 'top-to-bottom' | 'radial-out';

export interface ScribbleDrawProps {
  /** Beat's duration in frames — drives the progress math. The
   *  caller (MotionScene) sources this from the Sequence wrapper's
   *  durationInFrames so the reveal lands exactly when the beat ends. */
  durationInFrames: number;
  /** Direction of the reveal. Default 'left-to-right' (reading order,
   *  the most natural "draw" direction for a Western audience). */
  direction?: ScribbleDrawDirection;
  /** Background color of the cover that recedes — should match the
   *  scene's canvas / pillarbox color so the reveal looks like the
   *  drawing surface, not a separate sticker. Defaults to the
   *  style-guide's warm-white #FCFCFA. */
  coverColor?: string;
  /** When true, log entry-frame state on frame 0. */
  diagnose?: boolean;
}

const DEFAULT_COVER_COLOR = '#FCFCFA';
/** Soft-edge feather width as % of the canvas's chosen axis. 5 % @
 *  1920 px = ~96 px — enough to read as "ink seeping in," not a hard
 *  wipe. Tune by re-rendering side-by-side if it later reads off. */
const FEATHER_PCT = 5;

export const ScribbleDraw: React.FC<ScribbleDrawProps> = ({
  durationInFrames,
  direction = 'left-to-right',
  coverColor,
  diagnose = false,
}) => {
  const frame = useCurrentFrame();
  const safeDuration = Math.max(1, durationInFrames);
  const progress = Math.max(0, Math.min(1, frame / safeDuration));
  const mask = buildScribbleDrawMask(progress, direction);
  const fill =
    typeof coverColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(coverColor)
      ? coverColor
      : DEFAULT_COVER_COLOR;

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 scribble-draw mounted]', {
      duration_in_frames: safeDuration,
      direction,
      cover_color: fill,
    });
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: fill,
          // Mask: at progress=0 the entire cover is opaque (image
          // hidden). As progress grows, the mask becomes transparent
          // from the leading edge, revealing the image. Both
          // `mask-image` and the WebKit-prefixed alias for safety
          // (Remotion's Chromium-in-render respects both).
          WebkitMaskImage: mask,
          maskImage: mask,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * Build the CSS `mask-image` gradient that drives the reveal. Pure —
 * exported so unit tests can pin the gradient stops at progress
 * checkpoints (0, 0.5, 1.0). A regression on the formula silently
 * shifts EVERY scribble-draw render off by a few percent.
 *
 * Mask semantics: `transparent` regions HIDE the cover (so the
 * underlying image shows through); `black` regions KEEP the cover
 * opaque (so the underlying image is hidden).
 *
 * At progress=0: the leading edge is at the canvas's far edge, so the
 * gradient is "transparent 0..-feather%, black 0..100%" — the whole
 * cover is opaque, image fully hidden.
 *
 * At progress=1: the leading edge is past the far side, so the
 * gradient is "transparent 0..100%, black 105..100%" — the whole
 * cover is transparent, image fully visible.
 *
 * In between: a soft-edged transition window of `feather` % moves
 * along the chosen axis.
 */
export function buildScribbleDrawMask(
  progress: number,
  direction: ScribbleDrawDirection,
  featherPct: number = FEATHER_PCT,
): string {
  const clamped = Math.max(0, Math.min(1, progress));
  // The leading edge of the transparent-to-black transition (the
  // point past which the cover is still opaque). Extends past 100 so
  // the final frame is a fully-transparent cover.
  const leading = clamped * (100 + featherPct);
  // The trailing edge (the point at which the cover starts to fade
  // out). `featherPct` behind the leading edge for the soft seep.
  const trailing = leading - featherPct;

  // Gradient stops, identical structure for all three directions.
  // Order: transparent (image visible) → soft transition → black
  // (cover visible / image hidden). The mask follows the chosen
  // direction's gradient function.
  const stops = `transparent 0%, transparent ${trailing}%, black ${leading}%, black 100%`;

  if (direction === 'top-to-bottom') {
    return `linear-gradient(to bottom, ${stops})`;
  }
  if (direction === 'radial-out') {
    return `radial-gradient(circle at center, ${stops})`;
  }
  // Default + 'left-to-right'.
  return `linear-gradient(to right, ${stops})`;
}
