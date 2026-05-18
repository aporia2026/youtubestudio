import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';

/**
 * Burned-in captions overlay.
 *
 * Phase 4 of `_plans/2026-05-18-shot-graph-editor.md`. Renders a
 * caption box over the bottom-third of the frame for each segment's
 * active time window. Each segment owns its own `<Sequence>` so
 * Remotion's seek + render path handles activation without needing
 * a manual currentFrame check at every render.
 *
 * Text size + position were picked to land below the typical 16:9
 * action-safe area and above the bottom edge. Mirrors the editor's
 * HTML preview overlay so creators see the same thing in the
 * preview and the rendered MP4.
 *
 * No animations in v1 — captions hard-cut in / out at segment
 * boundaries. Cross-fade or word-by-word reveal would be Phase 5.
 */
interface CaptionSegment {
  /** Segment start in seconds from the start of the video. */
  start: number;
  /** Segment end in seconds. */
  end: number;
  text: string;
}

interface CaptionsOverlayProps {
  segments: CaptionSegment[];
}

export const CaptionsOverlay: React.FC<CaptionsOverlayProps> = ({ segments }) => {
  const { fps, width, height } = useVideoConfig();

  if (!segments || segments.length === 0) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {segments.map((seg, i) => {
        // Defensive: ignore malformed segments that would produce
        // negative or zero-frame sequences. The renderer would still
        // render them safely but they pollute the composition tree.
        const startFrame = Math.max(0, Math.round(seg.start * fps));
        const durationFrames = Math.max(1, Math.round((seg.end - seg.start) * fps));
        const text = seg.text?.trim();
        if (!text) return null;
        return (
          <Sequence
            key={i}
            from={startFrame}
            durationInFrames={durationFrames}
            name={`Caption: ${text.slice(0, 40)}`}
          >
            <AbsoluteFill
              style={{
                pointerEvents: 'none',
                alignItems: 'center',
                justifyContent: 'flex-end',
                // Bottom-third placement: leave roughly 12% of frame
                // height as bottom padding so the caption sits above
                // device safe-zones (UI overlays, watermarks) but
                // doesn't crowd the action area.
                paddingBottom: Math.round(height * 0.12),
                paddingLeft: Math.round(width * 0.08),
                paddingRight: Math.round(width * 0.08),
              }}
            >
              <span
                style={{
                  background: 'rgba(0, 0, 0, 0.75)',
                  color: '#ffffff',
                  // Cap text size at ~3.6% of frame height so 4K
                  // renders don't produce monster captions. Floor
                  // at 24 px so SD renders still read.
                  fontSize: Math.max(24, Math.round(height * 0.036)),
                  fontWeight: 600,
                  lineHeight: 1.3,
                  padding: '6px 14px',
                  borderRadius: 6,
                  textAlign: 'center',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.85)',
                  maxWidth: '100%',
                }}
              >
                {text}
              </span>
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
