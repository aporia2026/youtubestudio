import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { TextOverlay } from '../types';

/**
 * Doc-level text-overlay layer — Phase 4 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Renders each `TextOverlay` as its own `<Sequence>` so Remotion's
 * frame routing handles activation. Two preset positions in v1:
 *
 *   lower-third  — bottom-third of the frame, similar zone to the
 *                  per-shot LowerThird but doc-controlled so it can
 *                  span multiple shots
 *   top-center   — slightly below the top, leaves room for the
 *                  section-title stripe if present
 *
 * Fade-in is a simple opacity interpolation over `fadeInMs`. No
 * out-fade — overlays hard-cut when their window ends. Animation
 * tuning is explicitly out of scope per the plan.
 */
interface TextOverlayLayerProps {
  overlays: TextOverlay[];
}

export const TextOverlayLayer: React.FC<TextOverlayLayerProps> = ({ overlays }) => {
  const { fps } = useVideoConfig();
  if (!overlays || overlays.length === 0) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {overlays.map((overlay) => {
        if (!overlay.text?.trim()) return null;
        const fromFrame = Math.max(0, Math.round((overlay.startMs / 1000) * fps));
        const durationFrames = Math.max(1, Math.round(((overlay.endMs - overlay.startMs) / 1000) * fps));
        return (
          <Sequence
            key={overlay.id}
            from={fromFrame}
            durationInFrames={durationFrames}
            name={`Overlay: ${overlay.text.slice(0, 40)}`}
          >
            <SingleOverlay overlay={overlay} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SingleOverlay: React.FC<{ overlay: TextOverlay }> = ({ overlay }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();

  const fadeInFrames = Math.max(1, Math.round(((overlay.fadeInMs ?? 250) / 1000) * fps));
  const opacity = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fontSize = Math.max(
    24,
    Math.round(height * (overlay.fontSizeFraction ?? 0.045)),
  );
  const color = overlay.color ?? '#ffffff';
  const bgOpacity = typeof overlay.backgroundOpacity === 'number'
    ? Math.min(1, Math.max(0, overlay.backgroundOpacity))
    : 0.85;

  const positionStyle: React.CSSProperties =
    overlay.position === 'top-center'
      ? {
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingTop: Math.round(height * 0.14),
        }
      : {
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingBottom: Math.round(height * 0.16),
        };

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        opacity,
        paddingLeft: Math.round(width * 0.08),
        paddingRight: Math.round(width * 0.08),
        ...positionStyle,
      }}
    >
      <span
        style={{
          background: `rgba(0, 0, 0, ${bgOpacity})`,
          color,
          fontSize,
          fontWeight: 700,
          lineHeight: 1.2,
          padding: '10px 22px',
          borderRadius: 8,
          textAlign: 'center',
          textShadow: '0 1px 2px rgba(0,0,0,0.85)',
          maxWidth: '100%',
          whiteSpace: 'pre-line',
        }}
      >
        {overlay.text}
      </span>
    </AbsoluteFill>
  );
};
