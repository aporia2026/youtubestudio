/**
 * PropSlideIn — paint_explainer_v1 prop reveal.
 *
 * Slides a (typically transparent-background) prop PNG in from
 * offscreen to its landing anchor, settles with a soft spring.
 * Mounted by MotionScene inside a Remotion `<Sequence>` so the
 * slide is bounded to the beat's window.
 *
 * Visual: the prop lives at the layer above the static base /
 * mouth-swap and below labels. The spring config is gentler than
 * `<RealPhotoPunchIn>`'s polaroid pop because a prop is supposed to
 * read as "an element coming into the scene" rather than "a card
 * landing on the table" — overshoot here would distract from the
 * narration.
 *
 * Asset resolution:
 *   - `url` prop is the prop's PNG URL. Typically populated by
 *     `beat.payload.assetUrl` upstream.
 *   - The pipeline that generates transparent-prop PNGs from
 *     `beat.payload.propPromptHint` is deferred to a follow-up
 *     commit (the architecture plan §15 PR 5 item 3). Until that
 *     ships, the LLM can populate `assetUrl` directly for testing
 *     or the renderer falls back to a no-render (caller sees no
 *     prop, but no broken-image icon either).
 *
 * Plan: §4 (Layer 1 — PropSlideIn) of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */
import React, { useState } from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { MotionAnchor } from '../utils';

export type PropSlideInDirection = 'left' | 'right' | 'top' | 'bottom';

export interface PropSlideInProps {
  /** Public URL of the prop PNG. Transparent-background is ideal
   *  (the prop reads as a foreground element on the doodle canvas)
   *  but opaque PNGs degrade gracefully — they just look like a
   *  rectangular sticker. */
  url: string;
  /** Anchor for the prop's CENTER, % of canvas. When undefined or
   *  non-specific, lands at (50, 50) — centered on the canvas. */
  anchor?: MotionAnchor;
  /** Which side the prop enters from. Default 'right' — reads as
   *  "the new element appears alongside the existing scene" in a
   *  Western reading-order composition. */
  fromDirection?: PropSlideInDirection;
  /** Prop width as % of frame width. Default 22 — small enough to
   *  read as an accent prop without dominating the character. */
  widthPct?: number;
  /** Aspect ratio (width / height). Default 1 (square — most props
   *  are roughly square or trimmed to be). The LLM can override
   *  with the prop's natural aspect via the beat payload. */
  aspectRatio?: number;
  /** When true, log entry-frame state on frame 0. */
  diagnose?: boolean;
}

export const PropSlideIn: React.FC<PropSlideInProps> = ({
  url,
  anchor,
  fromDirection = 'right',
  widthPct,
  aspectRatio,
  diagnose = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const [errored, setErrored] = useState(false);

  // Anchor resolution (same shape as RealPhotoPunchIn / LabelPopOn).
  const xPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.xPct)
      ? Math.max(0, Math.min(100, anchor.xPct))
      : 50;
  const yPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.yPct)
      ? Math.max(0, Math.min(100, anchor.yPct))
      : 50;

  // Size resolution. Same clamp envelope as RealPhotoPunchIn so the
  // genre's accent-prop sizing stays consistent across components.
  const widthRatio = Math.max(0.06, Math.min(0.6, (widthPct ?? 22) / 100));
  const aspect = aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;

  const propWidthPx = compositionWidth * widthRatio;
  const propHeightPx = propWidthPx / aspect;

  // Landing position (where the prop ends up at progress=1).
  const landedLeft = (xPct / 100) * compositionWidth - propWidthPx / 2;
  const landedTop = (yPct / 100) * compositionHeight - propHeightPx / 2;

  // Slide progress: spring from 0 → 1. Gentler than the polaroid
  // pop — damping=14 / stiffness=110 gives a clear slide with a
  // soft settle, no visible overshoot bounce. The narrator should
  // still own the scene's attention when the prop enters.
  const progress = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 110, mass: 0.7, overshootClamping: false },
    from: 0,
    to: 1,
  });

  // Offscreen origin (where the prop starts at progress=0). Each
  // direction begins one full prop width / height beyond the edge
  // so the slide starts fully invisible.
  const originLeft =
    fromDirection === 'left'
      ? -propWidthPx
      : fromDirection === 'right'
      ? compositionWidth
      : landedLeft;
  const originTop =
    fromDirection === 'top'
      ? -propHeightPx
      : fromDirection === 'bottom'
      ? compositionHeight
      : landedTop;

  // Interpolate from origin → landed by progress.
  const left = interpolate(progress, [0, 1], [originLeft, landedLeft]);
  const top = interpolate(progress, [0, 1], [originTop, landedTop]);

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 prop-slide mounted]', {
      url_head: url.slice(0, 80),
      from_direction: fromDirection,
      anchor_xPct: xPct,
      anchor_yPct: yPct,
      width_px: Math.round(propWidthPx),
      height_px: Math.round(propHeightPx),
      aspect,
    });
  }

  if (!url || errored) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <Img
        src={url}
        onError={() => {
          console.warn('[paint-explainer-v1 prop-slide] image load failed', {
            url_head: url.slice(0, 80),
          });
          setErrored(true);
        }}
        style={{
          position: 'absolute',
          left,
          top,
          width: propWidthPx,
          height: propHeightPx,
          objectFit: 'contain',
          display: 'block',
        }}
      />
    </AbsoluteFill>
  );
};
