import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { TextOverlay } from '../types';
import { LILITA_ONE_FAMILY } from '../fonts-registry';

/** Glyph variant for doc-level text overlays — mirrors the LowerThird
 *  variants. Phase 2 of `_plans/2026-05-25-style-aware-overlay-text.md`. */
export type TextOverlayVariant = 'default' | 'doodle-yellow';

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
  /** Glyph variant. Defaults to 'default' (original dark-box treatment).
   *  YouTubeVideo maps the doc's style id to a variant and passes it
   *  here so the doc-level overlays match the per-shot LowerThird's
   *  treatment for the active style. */
  variant?: TextOverlayVariant;
}

export const TextOverlayLayer: React.FC<TextOverlayLayerProps> = ({ overlays, variant = 'default' }) => {
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
            <SingleOverlay overlay={overlay} variant={variant} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SingleOverlay: React.FC<{ overlay: TextOverlay; variant: TextOverlayVariant }> = ({ overlay, variant }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();

  const fadeInFrames = Math.max(1, Math.round(((overlay.fadeInMs ?? 250) / 1000) * fps));
  const opacity = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

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

  // Variant branch — only the glyph styling and font size diverge.
  // Position, padding, fade-in are shared so a doc-level overlay
  // animates identically across styles.
  if (variant === 'doodle-yellow') {
    // Slightly larger than the default overlay because the bubble
    // font reads heavier at the same nominal size. Falls back to the
    // user's fontSizeFraction when they pinned one.
    const yellowFontSize = Math.max(
      32,
      Math.round(height * (overlay.fontSizeFraction ?? 0.065)),
    );
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
            fontFamily: LILITA_ONE_FAMILY,
            fontWeight: 400,
            // Honour per-overlay color override but default to the same
            // warm yellow the LowerThird variant uses.
            color: overlay.color ?? '#FCD34D',
            fontSize: yellowFontSize,
            lineHeight: 1.1,
            letterSpacing: 1,
            textAlign: 'center',
            maxWidth: '100%',
            whiteSpace: 'pre-line',
            WebkitTextStroke: '2px #000000',
            textShadow:
              '2px 2px 0 rgba(0,0,0,0.18), 0 0 1px #000, 0 0 1px #000',
            paintOrder: 'stroke fill',
          }}
        >
          {overlay.text}
        </span>
      </AbsoluteFill>
    );
  }

  // Default variant — original dark-box treatment unchanged.
  const fontSize = Math.max(
    24,
    Math.round(height * (overlay.fontSizeFraction ?? 0.045)),
  );
  const color = overlay.color ?? '#ffffff';
  const bgOpacity = typeof overlay.backgroundOpacity === 'number'
    ? Math.min(1, Math.max(0, overlay.backgroundOpacity))
    : 0.85;

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
