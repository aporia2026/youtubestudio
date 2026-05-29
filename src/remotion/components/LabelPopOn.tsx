/**
 * LabelPopOn — paint_explainer_v1 yellow comic-bold bubble label.
 *
 * Renders a goldenrod-yellow "polaroid sticker" label with a thick
 * black border, scale-pops on with overshoot, and disappears with the
 * end of its Sequence window. Matches the Paint Explainer reference's
 * signature emphasis device — every callout word ("Vaqueros",
 * "Donald Kessler", "1.6 billion") in the source videos comes through
 * this treatment.
 *
 * Visual design (style guide §4 — Font B / yellow callouts):
 *   - Background: goldenrod (#EBC347 default; overridable via the
 *     `paint_explainer_v1_settings.label_color_hex` doc setting).
 *   - Border: 3 px solid #1A1A1A (style-guide outline_black).
 *   - Corner radius: 14 px — bubble look without going pill-shaped.
 *   - Padding: 18 px horizontal / 8 px vertical for a chunky chip feel.
 *   - Text: bold, all-caps, ink-black, slight letter-spacing.
 *   - Soft red-tinged drop shadow (style-guide §4 — "yellow with a
 *     subtle red drop shadow" when set against bright backgrounds).
 *
 * Motion design (the "pop-on"):
 *   - Scale: spring 0 → ~1.15 → ~1.0 (overshoot enabled). Damping = 10,
 *     stiffness = 220 — punchier than RealPhotoPunchIn's 12/200 because
 *     a label is smaller / harder to register without exaggeration.
 *   - Opacity: 0 → 1 over the first 4 frames (~133 ms @ 30fps).
 *   - Slight ±2° rotation jitter on entrance settles to 0° as the
 *     spring resolves — hand-drawn-feel without going cartoony.
 *
 * Positioning:
 *   - Anchor `kind: 'specific'` → uses xPct/yPct as the label's CENTER.
 *   - Anchor `kind: 'auto-eyes'` → resolves to the shot's eyes anchor
 *     when threaded through (PR 5 vision-pass output), else 50 / 22
 *     (slightly above middle, above the action).
 *   - Anchor `kind: 'auto-mouth'` / `'auto-center'` / undefined →
 *     defaults to 50 / 22 (a safe "top center" position).
 *
 * Plan: §4 (Layer 1) of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */
import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { MotionAnchor } from '../utils';

export interface LabelPopOnProps {
  /** Display text. Rendered uppercase via CSS so the LLM can pass
   *  whatever case is natural for the script ("Donald Kessler",
   *  "1.6 billion") and the visual stays consistent. */
  text: string;
  /** Anchor for the label's CENTER, % of canvas (0–100). When
   *  undefined or non-specific, lands at 50,22 (safe top-center). */
  anchor?: MotionAnchor;
  /** Background color, hex (`#RRGGBB`). Defaults to the style-guide's
   *  goldenrod #EBC347. Overridden by the doc setting
   *  `paint_explainer_v1_settings.label_color_hex`. */
  colorHex?: string;
  /** Font size as % of frame height. 4.5 reads as the genre's
   *  reference size at 1080p; smaller compositions scale linearly. */
  fontHeightPct?: number;
  /** When true, log entry-frame state on frame 0 — mirrors the other
   *  paint_explainer_v1 components. */
  diagnose?: boolean;
}

const DEFAULT_COLOR_HEX = '#EBC347';
const BORDER_COLOR = '#1A1A1A';
const TEXT_COLOR = '#1A1A1A';
const FONT_HEIGHT_PCT_DEFAULT = 4.5;

export const LabelPopOn: React.FC<LabelPopOnProps> = ({
  text,
  anchor,
  colorHex,
  fontHeightPct,
  diagnose = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: compositionWidth, height: compositionHeight } = useVideoConfig();

  // Resolve position.
  const xPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.xPct)
      ? Math.max(0, Math.min(100, anchor.xPct))
      : 50;
  const yPct =
    anchor?.kind === 'specific' && Number.isFinite(anchor.yPct)
      ? Math.max(0, Math.min(100, anchor.yPct))
      : 22;

  // Resolve color (validate hex shape; fall back to default on garbage).
  const fill =
    typeof colorHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(colorHex)
      ? colorHex
      : DEFAULT_COLOR_HEX;

  // Font size derived from composition height so labels stay readable
  // across 720p / 1080p / 4k renders without per-resolution tweaks.
  const fontPx = Math.max(
    24,
    Math.round(compositionHeight * (fontHeightPct ?? FONT_HEIGHT_PCT_DEFAULT) / 100),
  );

  // Scale-pop. Damping = 10 gives a clear overshoot peak around
  // frame 6 (~200 ms @ 30fps), settled by frame 14 (~470 ms).
  const scale = spring({
    frame,
    fps,
    config: {
      damping: 10,
      stiffness: 220,
      mass: 0.5,
      overshootClamping: false,
    },
    from: 0,
    to: 1,
  });

  // Opacity ramps in fast — 4 frames so the label reads as confident.
  const opacity = interpolate(frame, [0, 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Rotation jitter on entrance: starts at ±2°, settles to 0 as the
  // spring resolves. The 'side' decision is deterministic-by-text so a
  // re-render produces the same tilt — important for Lambda renders.
  const rotationStart = pickSideJitter(text);
  const rotation = interpolate(frame, [0, 14], [rotationStart, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (diagnose && frame === 0) {
    console.info('[paint-explainer-v1 label-pop mounted]', {
      text_head: text.slice(0, 40),
      xPct,
      yPct,
      fill,
      font_px: fontPx,
      rotation_start_deg: rotationStart,
    });
  }

  // Render. The label is absolutely positioned with center-origin so
  // the scale-pop visually grows out of the anchor point, not the
  // top-left corner.
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: `${xPct}%`,
          top: `${yPct}%`,
          transform: `translate(-50%, -50%) scale(${scale}) rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          opacity,
          background: fill,
          color: TEXT_COLOR,
          border: `3px solid ${BORDER_COLOR}`,
          borderRadius: 14,
          padding: '8px 18px',
          fontSize: fontPx,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
          fontWeight: 900,
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          lineHeight: 1.0,
          whiteSpace: 'nowrap',
          // Subtle red-tinged drop shadow per style-guide §4 — reads
          // as a sticker against the doodle canvas without competing.
          boxShadow: '0 3px 0 rgba(180, 30, 30, 0.55), 0 8px 18px rgba(0,0,0,0.18)',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** Deterministically pick a small entry-rotation jitter from the
 *  label text. A simple xor-hash → ±2°. Same text → same tilt across
 *  preview / Lambda / re-renders, so the user can't see the label
 *  "jump" between sessions. */
function pickSideJitter(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return (h & 1) === 0 ? -2 : 2;
}
