/**
 * RealPhotoPunchIn — paint_explainer_v1 real-photo overlay with the
 * thin-black-rounded-frame + scale-pop animation that the Paint
 * Explainer reference videos use whenever a real photograph drops
 * into a doodle scene (style-guide §5: "embedded media frame …
 * thin black rounded-corner border (~6-8 px radius), like a polaroid
 * or screen bezel").
 *
 * Mounted by `<MotionScene>` inside a Remotion `<Sequence>` so the
 * component only renders for the beat's window — caller is
 * responsible for the time-shift. The component's own frame counter
 * starts at 0 at the beat's start.
 *
 * Visual design:
 *   - 4 px solid `#1A1A1A` border (matches outline_black from the
 *     style guide; pure-black `#000` looks plastic against doodle
 *     line art).
 *   - 8 px corner radius — the polaroid look without bleeding into
 *     full rounded-rectangle "card" territory.
 *   - Soft drop shadow (0 8 px 24 px black @ 25 %) anchored beneath
 *     the frame so the photo reads as a physical object sitting on
 *     top of the doodle canvas.
 *   - Default size 40 % of frame width, 4:3 aspect. The LLM can
 *     refine via beat payload later (PR 5 wires anchor + size from
 *     the vision-pass output).
 *
 * Motion design (the "punch-in"):
 *   - Scale springs from 0 → 1.05 → ~1.0 (overshoot enabled).
 *     Damping = 12 with stiffness = 200 is the "physical card lands
 *     on a table" feel — bouncier than RealImageOverlay's 16/120.
 *   - Opacity ramps 0 → 1 over the first 5 frames so the entry
 *     reads as confident rather than blasted-on.
 *
 * Falls back gracefully:
 *   - No `url` → renders nothing (caller can pass `shot.overlay?.url`
 *     and we silently skip when overlay isn't resolved yet).
 *   - Image load error → also renders nothing (logged once).
 *
 * Plan: §4 (Layer 1) of
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

export interface RealPhotoPunchInProps {
  /** Image URL to composite. Typically `shot.overlay?.url` from the
   *  existing auto-fetched stock-photo infrastructure, or
   *  `beat.payload.assetUrl` when the LLM emitted a per-beat asset. */
  url: string;
  /** Where on the 1920×1080 canvas the photo's CENTER lands, expressed
   *  as a percentage. Defaults to dead-center (50, 50). The PR 5
   *  vision-pass will plug into this via `MotionBeat.anchor` for
   *  shots where the auto-mouth / auto-eyes anchor is the wrong
   *  place to drop a photo. */
  anchor?: MotionAnchor;
  /** Photo width as % of frame width. Default 40. Range 10–80.
   *  Height follows the photo's 4:3 default aspect (caller hasn't
   *  supplied one yet — wired in a later PR). */
  widthPct?: number;
  /** Photo's aspect ratio as `width / height`. Default 4/3 (1.333).
   *  Pass `16 / 9`, `1`, `3 / 4` etc. for landscape / square /
   *  portrait stock photos respectively. */
  aspectRatio?: number;
  /** When true, log entry-frame state on frame 0 (mirrors the other
   *  paint_explainer_v1 components). */
  diagnose?: boolean;
}

/** 4 px frame border + 8 px corner radius. Tuned against
 *  reference videos at 1920×1080; resamples linearly for other
 *  compositions via `border` taking pixel values that the
 *  Remotion compositor scales with the rest of the canvas. */
const FRAME_BORDER_PX = 4;
const FRAME_CORNER_RADIUS_PX = 8;
const FRAME_INSET_COLOR = '#FCFCFA'; // matches the style-guide background
const FRAME_BORDER_COLOR = '#1A1A1A'; // matches outline_black

export const RealPhotoPunchIn: React.FC<RealPhotoPunchInProps> = ({
  url,
  anchor,
  widthPct,
  aspectRatio,
  diagnose = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const [errored, setErrored] = useState(false);

  // Resolve placement. 'specific' is the only anchor kind that
  // carries explicit coords today; other kinds fall back to center
  // because PR 1 doesn't have the vision-pass resolver yet (PR 5).
  const xPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.xPct)
      ? Math.max(0, Math.min(100, anchor.xPct))
      : 50;
  const yPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.yPct)
      ? Math.max(0, Math.min(100, anchor.yPct))
      : 50;

  // Size resolution: percent-of-frame width, clamped to a sane
  // envelope. 40 % default reads as a clear focal element without
  // dominating the doodle composition around it.
  const widthRatio = Math.max(
    0.10,
    Math.min(0.80, (widthPct ?? 40) / 100),
  );
  const aspect = aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0
    ? aspectRatio
    : 4 / 3;

  const photoWidthPx = compositionWidth * widthRatio;
  const photoHeightPx = photoWidthPx / aspect;

  // Position so the anchor coords land at the photo's center.
  const left = (xPct / 100) * compositionWidth - photoWidthPx / 2;
  const top = (yPct / 100) * compositionHeight - photoHeightPx / 2;

  // Scale-pop with overshoot. Spring config tuned for the
  // "card-lands-on-table" feel: low damping = bouncy, high
  // stiffness = quick settle. overshootClamping defaults to false in
  // Remotion, but we set it explicitly for grep-ability.
  const scale = spring({
    frame,
    fps,
    config: {
      damping: 12,
      stiffness: 200,
      mass: 0.6,
      overshootClamping: false,
    },
    from: 0,
    to: 1,
  });

  // Opacity ramps in fast so the photo doesn't materialise from
  // nothing — 5 frames @ 30 fps = 167 ms, just past the eye's
  // change-blindness threshold.
  const opacity = interpolate(frame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 real-photo-punch mounted]', {
      url_head: url.slice(0, 80),
      xPct,
      yPct,
      widthPx: Math.round(photoWidthPx),
      heightPx: Math.round(photoHeightPx),
      aspect,
    });
  }

  if (!url || errored) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: photoWidthPx,
          height: photoHeightPx,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          opacity,
          // The polaroid frame: thin black border + slight inset
          // background so the photo doesn't bleed into the border
          // anti-aliasing. Background visible only on transparent
          // PNGs; opaque JPGs cover it fully.
          background: FRAME_INSET_COLOR,
          border: `${FRAME_BORDER_PX}px solid ${FRAME_BORDER_COLOR}`,
          borderRadius: FRAME_CORNER_RADIUS_PX,
          overflow: 'hidden',
          // Drop shadow tracks the frame's rounded rectangle —
          // box-shadow is the right primitive here (filter:
          // drop-shadow follows the alpha mask, which we don't have).
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}
      >
        <Img
          src={url}
          onError={() => {
            console.warn('[paint-explainer-v1 real-photo-punch] image load failed', {
              url_head: url.slice(0, 80),
            });
            setErrored(true);
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
