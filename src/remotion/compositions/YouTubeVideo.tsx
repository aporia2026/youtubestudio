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
import { CaptionsOverlay } from '../components/CaptionsOverlay';
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

      {/* Voiceover audio — runs for the full video.
       *
       *  `pauseWhenBuffering` is critical for the preview player: when a
       *  per-scene `<OffthreadVideo>` in BRollScene mounts and needs to
       *  buffer, Chromium's audio scheduler can briefly drop frames on
       *  *this* audio element — perceived by the user as a "voiceover
       *  jump" at scene boundaries even though the timeline never seeks.
       *  Enabling pauseWhenBuffering tells Remotion to halt the whole
       *  player when buffering is in flight, so audio + frame advance
       *  resume together. No effect during server-side export. */}
      {config.voiceoverUrl && (
        <Audio src={config.voiceoverUrl} volume={1} pauseWhenBuffering />
      )}

      {/* Background music — ducked under voiceover. Same buffering
       *  guarantee as the voiceover so mid-render seeks don't drift. */}
      {config.musicUrl && (
        <Audio
          src={config.musicUrl}
          volume={config.musicVolume ?? 0.12}
          loop
          pauseWhenBuffering
        />
      )}

      {/* Render each shot as a Sequence. Scenes ALWAYS fill the full
          1920×1080 frame; the section-title stripe (rendered as a
          separate, later set of Sequences below) overlays the top
          stripe-height pixels on top. Per-row image generation gets
          a safe-top prompt directive when the row has a sectionTitle
          (see /api/generate/production-doc/image route) so the
          stripe lands on intentional negative space rather than
          covering focal content. This keeps the renderer simple —
          no aspect-ratio juggling, no scene math, just a clean
          z-stack: scene → overlay → stripe. */}
      {config.shots.map((shot, i) => {
        const fromFrame = msToFrame(shot.startMs, fps);
        const durationInFrames = Math.max(msToFrame(shot.durationMs, fps), 1);
        const prevShot = i > 0 ? config.shots[i - 1] : null;

        // Letterbox layout: when a shot has a section title and the layout
        // is 'letterbox' (the default since 2026-05-17), reserve the top
        // `stripeHeightPx` of the frame for the stripe and render the
        // scene + overlay inside a smaller container below. The scene's
        // background is overridden with the row's `pillarboxColor` so
        // any space the image's `object-fit: contain` leaves shows that
        // colour (pillarbox bars on left/right for narrower images,
        // top/bottom bars for ultra-wide images). See plan
        // _plans/2026-05-17-section-title-letterbox-and-overlay-blending.md.
        const useLetterbox =
          Boolean(shot.sectionTitle) &&
          (shot.sectionTitleLayout ?? 'letterbox') === 'letterbox';
        const pillarboxColor =
          shot.pillarboxColor || config.pillarboxColorDefault || '#FFFFFF';
        const sceneConfig = useLetterbox
          ? { ...config, brand: { ...config.brand, backgroundColor: pillarboxColor } }
          : config;
        const stripeHeightPx = useLetterbox
          ? config.height * clampSectionStripeFraction(config.thumbnail?.stripeHeightFraction)
          : 0;
        const containerWidth = config.width;
        const containerHeight = config.height - stripeHeightPx;

        const sceneAndOverlay = (
          <>
            <SceneRouter
              shot={shot}
              previousShot={prevShot}
              durationInFrames={durationInFrames}
              config={sceneConfig}
              shotIndex={i}
            />
            {/* Real-image overlay (logo / brand mark / screenshot) sits
                ABOVE the scene composition but BELOW the section title
                stripe in z-order. No-op when shot.overlay is undefined.
                In letterbox mode it positions against the smaller
                container so it never crosses into the stripe area. */}
            <RealImageOverlay
              shot={shot}
              frameWidth={containerWidth}
              frameHeight={containerHeight}
            />
          </>
        );

        return (
          <Sequence
            key={i}
            from={fromFrame}
            durationInFrames={durationInFrames}
            name={`Shot ${i + 1}: ${shot.thumbnailZoomTo ? 'thumbnail-zoom' : shot.sceneType}${useLetterbox ? ' (letterbox)' : ''}`}
          >
            {useLetterbox ? (
              <div
                style={{
                  position: 'absolute',
                  top: stripeHeightPx,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  overflow: 'hidden',
                  background: pillarboxColor,
                }}
              >
                {sceneAndOverlay}
              </div>
            ) : (
              sceneAndOverlay
            )}
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

      {/* Burned-in captions — Phase 4 of the shot-graph editor plan.
          Rendered LAST so the caption box sits above scenes + stripes
          in z-order. When `config.captions` is absent or empty the
          component renders nothing — pre-Phase-4 renders are byte-
          identical to today. */}
      {config.captions && config.captions.length > 0 && (
        <CaptionsOverlay segments={config.captions} />
      )}
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
  // doc carries a thumbnail, (c) the target id resolves to a region, AND
  // (d) the row has no per-row visual of its own. The per-row imageUrl /
  // videoUrl is the fresher signal — when the user (re)generates an image
  // or animates a row, the doc table cell switches to that asset, and the
  // player must match. Without this guard the player kept zooming into a
  // stale section-divider composite while the doc table showed the new
  // per-row image — same row, two different visuals.
  const hasRowVisual = Boolean(shot.imageUrl || shot.videoUrl);
  const targetRegion = findRegion(config, shot.thumbnailZoomTo);
  if (targetRegion && config.thumbnail && !hasRowVisual) {
    // Smooth-transition tour only applies when the previous shot was
    // ITSELF rendered as a thumbnail-zoom — i.e. the previous shot had
    // no per-row visual that pre-empted the same routing rule above. A
    // previous shot that played as b-roll never visually "left from"
    // its region, so starting the camera there would create a hard
    // cut from b-roll directly into a region-anchored zoom.
    const previousRegion =
      previousShot && !previousShot.imageUrl && !previousShot.videoUrl
        ? findRegion(config, previousShot.thumbnailZoomTo)
        : null;
    const transition = resolveTransition(shot, config.thumbnail.defaultTransition);
    const zoomFadeEnabled = shot.sceneFade ?? config.sceneFadeEnabled ?? true;
    return (
      <ThumbnailZoomScene
        durationInFrames={durationInFrames}
        brand={brand}
        thumbnail={config.thumbnail}
        region={targetRegion}
        previousRegion={previousRegion}
        transition={transition}
        fadeEnabled={zoomFadeEnabled}
      />
    );
  }

  const suppressLowerThirds = config.suppressLowerThirds === true;
  // Resolve the scene-to-scene cross-fade for this shot. Order:
  // per-row `sceneFade` → doc-level `sceneFadeEnabled` → historical
  // default (`true`). `false` here disables the SceneTransition
  // overlay AND the opening fade-in on the first shot AND the
  // closing fade-out on the last shot. See plan
  // _plans/2026-05-17-scene-transition-controls.md.
  const fadeEnabled = shot.sceneFade ?? config.sceneFadeEnabled ?? true;
  if (shotIndex === 0 || shot.sceneFade !== undefined) {
    console.info('[scene-fade resolved]', {
      shotIndex,
      perRow: shot.sceneFade,
      docDefault: config.sceneFadeEnabled,
      resolved: fadeEnabled,
    });
  }
  const props = { shot, durationInFrames, brand, fadeEnabled };
  switch (shot.sceneType) {
    case 'title-card':
      return <TitleCardScene {...props} />;
    case 'text-reveal':
      return <TextRevealScene {...props} />;
    case 'icon-scene':
      return <IconScene {...props} />;
    case 'screen-mockup':
      return <ScreenMockupScene {...props} suppressLowerThird={suppressLowerThirds} />;
    case 'outro':
      return <OutroScene {...props} />;
    case 'b-roll':
    case 'split-scene':
    default:
      return <BRollScene {...props} shotIndex={shotIndex} suppressLowerThird={suppressLowerThirds} />;
  }
};
