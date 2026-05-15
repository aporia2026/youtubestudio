import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  useVideoConfig,
} from 'remotion';
import { TitleCardScene } from '../scenes/TitleCardScene';
import { BRollScene } from '../scenes/BRollScene';
import { TextRevealScene } from '../scenes/TextRevealScene';
import { IconScene } from '../scenes/IconScene';
import { ScreenMockupScene } from '../scenes/ScreenMockupScene';
import { OutroScene } from '../scenes/OutroScene';
import { ThumbnailZoomScene } from '../scenes/ThumbnailZoomScene';
import { SectionTitleStripe, clampSectionStripeFraction } from '../components/SectionTitleStripe';
import { RealImageOverlay } from '../components/RealImageOverlay';
import {
  VideoConfig,
  VideoShot,
  ThumbnailRegion,
  ThumbnailTransitionConfig,
} from '../types';
import { msToFrame } from '../utils';

export interface YouTubeVideoProps {
  config: VideoConfig;
}

// Doc-level + built-in transition fallbacks. Order: per-shot override →
// per-doc default → these. Defined here (not pulled from the editor's
// SectionRowControls) so the renderer has no UI dep.
const FALLBACK_TRANSITION: Required<Pick<ThumbnailTransitionConfig,
  'kind' | 'holdAtFullMs' | 'zoomDurationMs' | 'holdAtTargetMs' | 'easing'
>> = {
  kind: 'hard-cut',
  holdAtFullMs: 500,
  zoomDurationMs: 1000,
  holdAtTargetMs: 600,
  easing: 'spring-smooth',
};

function resolveTransition(
  shot: VideoShot,
  docDefault: ThumbnailTransitionConfig | undefined,
): ThumbnailTransitionConfig {
  return {
    ...FALLBACK_TRANSITION,
    ...(docDefault ?? {}),
    ...(shot.thumbnailTransition ?? {}),
  };
}

function findRegion(
  config: VideoConfig,
  id: string | undefined,
): ThumbnailRegion | null {
  if (!id || !config.thumbnail) return null;
  // Defend against an older doc whose JSON predates the regions field.
  const regions = config.thumbnail.regions ?? [];
  return regions.find(r => r.id === id) ?? null;
}

/**
 * Main YouTube video composition (16:9, 1920×1080).
 * Routes each VideoShot to the appropriate scene component,
 * overlays voiceover audio, and optionally background music.
 *
 * Phase 5 of the thumbnail-zoom feature adds two render-side knobs
 * orchestrated here:
 *   - shots with `thumbnailZoomTo` route to `ThumbnailZoomScene`.
 *   - shots with `sectionTitle` get a `SectionTitleStripe` overlay,
 *     regardless of which scene component renders below it.
 */
export const YouTubeVideo: React.FC<YouTubeVideoProps> = ({ config }) => {
  const { fps, height: frameHeight } = useVideoConfig();
  const stripeFraction = clampSectionStripeFraction(config.thumbnail?.stripeHeightFraction);
  const stripeHeightPx = frameHeight * stripeFraction;

  // Group consecutive shots that share the same `sectionTitle` into ONE
  // Sequence around the SectionTitleStripe. This way the stripe stays
  // mounted across scene transitions within a section — no re-entrance,
  // no flicker, "always there" feel. The previous design rendered the
  // stripe inside EACH shot's Sequence which re-mounted (and previously
  // re-animated) on every cut.
  type SectionRun = { title: string; startFromFrame: number; endFromFrame: number };
  const sectionRuns: SectionRun[] = [];
  {
    let current: SectionRun | null = null;
    for (const shot of config.shots) {
      const fromFrame = msToFrame(shot.startMs, fps);
      const dur = Math.max(msToFrame(shot.durationMs, fps), 1);
      const endFrame = fromFrame + dur;
      const title = shot.sectionTitle?.trim();
      if (title) {
        if (current && current.title === title && current.endFromFrame === fromFrame) {
          current.endFromFrame = endFrame;
        } else {
          if (current) sectionRuns.push(current);
          current = { title, startFromFrame: fromFrame, endFromFrame: endFrame };
        }
      } else if (current) {
        sectionRuns.push(current);
        current = null;
      }
    }
    if (current) sectionRuns.push(current);
  }

  return (
    <AbsoluteFill style={{ background: config.brand.backgroundColor }}>

      {/* Voiceover audio — runs for the full video */}
      {config.voiceoverUrl && (
        <Audio src={config.voiceoverUrl} volume={1} />
      )}

      {/* Background music — ducked under voiceover */}
      {config.musicUrl && (
        <Audio
          src={config.musicUrl}
          volume={config.musicVolume ?? 0.12}
          loop
        />
      )}

      {/* Render each shot as a Sequence. When a shot has a sectionTitle
          the scene is offset to render below the stripe instead of being
          partially covered by it. */}
      {config.shots.map((shot, i) => {
        const fromFrame = msToFrame(shot.startMs, fps);
        const durationInFrames = Math.max(msToFrame(shot.durationMs, fps), 1);
        const prevShot = i > 0 ? config.shots[i - 1] : null;
        const hasSectionTitle = Boolean(shot.sectionTitle?.trim());

        const sceneRouter = (
          <SceneRouter
            shot={shot}
            previousShot={prevShot}
            durationInFrames={durationInFrames}
            config={config}
            shotIndex={i}
          />
        );

        return (
          <Sequence
            key={i}
            from={fromFrame}
            durationInFrames={durationInFrames}
            name={`Shot ${i + 1}: ${shot.thumbnailZoomTo ? 'thumbnail-zoom' : shot.sceneType}`}
          >
            {hasSectionTitle ? (
              // Offset the scene below the stripe so it gets the full
              // remaining frame without being cropped. The scene's
              // AbsoluteFill children will fill THIS container (not the
              // composition's full frame), so any percentage-based
              // layout adapts automatically. Scenes that hard-code
              // useVideoConfig().height into pixel positions may sit
              // slightly off-center vertically — that's an explicit
              // trade-off for keeping the scene un-cropped.
              <div
                style={{
                  position: 'absolute',
                  top: stripeHeightPx,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  overflow: 'hidden',
                  background: config.brand.backgroundColor,
                }}
              >
                {sceneRouter}
              </div>
            ) : (
              sceneRouter
            )}
            {/* Real-image overlay (logo / brand mark / screenshot) sits
                ABOVE the scene composition. RealImageOverlay is a no-op
                when shot.overlay is undefined. */}
            <RealImageOverlay shot={shot} />
          </Sequence>
        );
      })}

      {/* Section-title stripes — one Sequence per run of consecutive
          shots sharing a sectionTitle. Rendered AFTER the shot Sequences
          so the stripe always sits on top of the scene in z-order. */}
      {sectionRuns.map((run, idx) => (
        <Sequence
          key={`section-${idx}`}
          from={run.startFromFrame}
          durationInFrames={Math.max(run.endFromFrame - run.startFromFrame, 1)}
          name={`Section title: ${run.title}`}
        >
          <SectionTitleStripe
            text={run.title}
            brand={config.brand}
            heightFraction={config.thumbnail?.stripeHeightFraction}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// ─── Scene Router ─────────────────────────────────────────────────────────────

interface SceneRouterProps {
  shot: VideoShot;
  previousShot: VideoShot | null;
  durationInFrames: number;
  config: VideoConfig;
  shotIndex: number;
}

const SceneRouter: React.FC<SceneRouterProps> = ({
  shot, previousShot, durationInFrames, config, shotIndex,
}) => {
  const brand = config.brand;

  // Thumbnail-zoom routing wins when (a) a region target is set, (b) the
  // doc carries a thumbnail, and (c) the target id resolves to a region.
  // Any of those falsey → fall through to the inferred scene type so
  // misconfigured rows don't kill the render.
  const targetRegion = findRegion(config, shot.thumbnailZoomTo);
  if (targetRegion && config.thumbnail) {
    const previousRegion = previousShot
      ? findRegion(config, previousShot.thumbnailZoomTo)
      : null;
    const transition = resolveTransition(shot, config.thumbnail.defaultTransition);
    return (
      <ThumbnailZoomScene
        durationInFrames={durationInFrames}
        brand={brand}
        thumbnail={config.thumbnail}
        region={targetRegion}
        previousRegion={previousRegion}
        transition={transition}
      />
    );
  }

  const props = { shot, durationInFrames, brand };
  switch (shot.sceneType) {
    case 'title-card':
      return <TitleCardScene {...props} />;
    case 'text-reveal':
      return <TextRevealScene {...props} />;
    case 'icon-scene':
      return <IconScene {...props} />;
    case 'screen-mockup':
      return <ScreenMockupScene {...props} />;
    case 'outro':
      return <OutroScene {...props} />;
    case 'b-roll':
    case 'split-scene':
    default:
      return <BRollScene {...props} shotIndex={shotIndex} />;
  }
};
