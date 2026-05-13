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
import { SectionTitleStripe } from '../components/SectionTitleStripe';
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
  const { fps } = useVideoConfig();

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

      {/* Render each shot as a Sequence */}
      {config.shots.map((shot, i) => {
        const fromFrame = msToFrame(shot.startMs, fps);
        const durationInFrames = Math.max(msToFrame(shot.durationMs, fps), 1);
        const prevShot = i > 0 ? config.shots[i - 1] : null;

        return (
          <Sequence
            key={i}
            from={fromFrame}
            durationInFrames={durationInFrames}
            name={`Shot ${i + 1}: ${shot.thumbnailZoomTo ? 'thumbnail-zoom' : shot.sceneType}`}
          >
            <SceneRouter
              shot={shot}
              previousShot={prevShot}
              durationInFrames={durationInFrames}
              config={config}
              shotIndex={i}
            />
            {shot.sectionTitle && (
              <SectionTitleStripe
                text={shot.sectionTitle}
                brand={config.brand}
                heightFraction={config.thumbnail?.stripeHeightFraction}
              />
            )}
          </Sequence>
        );
      })}
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
