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
import { TextOverlayLayer } from '../components/TextOverlayLayer';
import {
  VideoConfig,
  VideoShot,
  ThumbnailRegion,
  ThumbnailTransitionConfig,
} from '../types';
import { dbToLinearGain, msToFrame } from '../utils';

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

/** Build the per-frame volume function for the voiceover `<Audio>`. The
 *  returned shape is what Remotion's `<Audio volume={…}>` expects: either
 *  a constant scalar or `(frame) => number`. We return a constant when no
 *  fades are configured (common case) so the renderer can skip per-frame
 *  evaluation. Otherwise we return a function that ramps gain linearly
 *  through the fade-in / fade-out windows.
 *
 *  Project duration (used to anchor the fade-out window) is the max of
 *  every shot's end frame — no separate field carries it. */
function makeVoiceoverVolume(
  config: VideoConfig,
  fps: number,
): number | ((frame: number) => number) {
  if (config.voiceoverMuted) return 0;
  const targetGain = dbToLinearGain(config.voiceoverVolumeDb ?? 0);
  const fadeInMs = Math.max(0, config.voiceoverFadeInMs ?? 0);
  const fadeOutMs = Math.max(0, config.voiceoverFadeOutMs ?? 0);
  if (fadeInMs === 0 && fadeOutMs === 0) return targetGain;

  const fadeInFrames = msToFrame(fadeInMs, fps);
  const fadeOutFrames = msToFrame(fadeOutMs, fps);
  // Total project duration in frames — end of the last shot wins. Empty
  // shot list (defensive) treats the project as zero-length, so the
  // fade-out window collapses and only the fade-in (if any) applies.
  const totalFrames = config.shots.reduce(
    (acc, s) => Math.max(acc, msToFrame(s.startMs + s.durationMs, fps)),
    0,
  );
  const fadeOutStartFrame = Math.max(0, totalFrames - fadeOutFrames);

  return (frame: number): number => {
    let gain = targetGain;
    if (fadeInFrames > 0 && frame < fadeInFrames) {
      gain *= frame / fadeInFrames;
    }
    if (fadeOutFrames > 0 && frame > fadeOutStartFrame) {
      const remaining = totalFrames - frame;
      gain *= Math.max(0, remaining) / fadeOutFrames;
    }
    return Math.max(0, gain);
  };
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
       *  Smooth preview playback across scene cuts is owned by the
       *  `premountFor={fps}` on the per-shot `<Sequence>` below: each
       *  scene's `<OffthreadVideo>` mounts 1 second early and buffers
       *  while the previous scene is still on screen, so the visible
       *  cut lands on already-loaded media and no buffer pause ever
       *  reaches this `<Audio>`. `pauseWhenBuffering` stays as a safety
       *  net for the rare case where a buffer stall still slips through
       *  (slow network, huge clip) — when it triggers it halts the
       *  whole player so audio + frames resume together instead of
       *  Chromium's audio scheduler silently dropping voiceover frames.
       *  No effect during server-side export.
       *
       *  Volume function applies, in order: mute → 0 short-circuit;
       *  otherwise target gain = `dbToLinearGain(volumeDb)`; fade-in
       *  ramps 0 → target over the first `fadeInMs`; fade-out ramps
       *  target → 0 over the last `fadeOutMs` of the project. */}
      {config.voiceoverUrl && (
        <Audio
          src={config.voiceoverUrl}
          volume={makeVoiceoverVolume(config, fps)}
          pauseWhenBuffering
        />
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
        // One-shot per-shot diagnostic for the first 5 shots: verifies
        // useLetterbox is actually true at render time when the data
        // says letterbox. Pairs with the [render] config effective
        // log so a creator reporting "letterbox shot has title
        // overlapping image" can see whether the wrapper was applied
        // or skipped. Hoisted out of the .map() to avoid logging once
        // per frame — Remotion re-evaluates the component each frame.
        if (i < 5) {
          console.info('[composition letterbox check]', {
            shotIndex: i,
            hasSectionTitle: Boolean(shot.sectionTitle),
            sectionTitleLayoutRaw: shot.sectionTitleLayout,
            useLetterbox,
            stripeHeightPx:
              Boolean(shot.sectionTitle) &&
              (shot.sectionTitleLayout ?? 'letterbox') === 'letterbox'
                ? config.height * clampSectionStripeFraction(config.thumbnail?.stripeHeightFraction)
                : 0,
          });
        }
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
            // Pre-mount the next scene 1s before it starts so its
            // `<OffthreadVideo>` (BRollScene) finishes buffering BEFORE
            // the shot becomes visible. Without this, every scene cut
            // triggers a fresh OffthreadVideo mount → buffer → the
            // sibling Audio's `pauseWhenBuffering` halts the player mid-
            // narration → user hears a "jump" at every transition.
            // Premount renders invisibly (opacity:0, pointer-events:none)
            // and is a no-op for render (env.isRendering branch). See
            // https://remotion.dev/docs/player/premounting and
            // https://remotion.dev/docs/troubleshooting/video-flicker.
            premountFor={fps}
            name={`Shot ${i + 1}: ${shot.thumbnailZoomTo ? 'thumbnail-zoom' : shot.sceneType}${useLetterbox ? ' (letterbox)' : ''}`}
          >
            {useLetterbox ? (
              // Explicit width + height instead of right:0 / bottom:0
              // inset positioning. Sequence wraps children in an
              // AbsoluteFill which is `display: flex, flexDirection:
              // column` — a position:absolute child styled with only
              // inset offsets can render inconsistently across
              // runtimes (browser Player vs Lambda headless Chromium).
              // Pinning explicit dimensions makes the box deterministic
              // regardless of the flex parent. See bug report:
              // letterbox shots showed title overlapping the image in
              // the rendered MP4 even when the data carried
              // sectionTitleLayout='letterbox'. 2026-05-24.
              <div
                style={{
                  position: 'absolute',
                  top: stripeHeightPx,
                  left: 0,
                  width: containerWidth,
                  height: containerHeight,
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
            variant={config.styleId === 'doodle_explainer_2' ? 'doodle-bold' : 'default'}
          />
        </Sequence>
      ))}

      {/* Doc-level text overlays. Sit between scenes/stripes and
          captions in z-order — overlays can decorate the video,
          captions sit on top of them so dialogue stays readable. */}
      {config.textOverlays && config.textOverlays.length > 0 && (
        <TextOverlayLayer
          overlays={config.textOverlays}
          variant={config.styleId === 'doodle_explainer_2' ? 'doodle-yellow' : 'default'}
        />
      )}

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
  // doc carries a thumbnail, AND (c) the target id resolves to a region.
  //
  // Precedence over per-row imageUrl/videoUrl is intentional (2026-05-22):
  // assigning a region via `thumbnail_zoom_to` is the user's explicit,
  // sticky declaration that this shot is a section divider. A per-row
  // image is an earlier auto-pipeline artifact (or a previously generated
  // animation) — the explicit assignment supersedes it. If a user wants
  // the row image instead, they clear the region assignment.
  const targetRegion = findRegion(config, shot.thumbnailZoomTo);
  if (targetRegion && config.thumbnail) {
    // Smooth-transition tour anchors against the previous shot's region
    // when the previous shot ALSO carries a `thumbnail_zoom_to` target.
    // Without one, the previous shot visually started elsewhere and
    // starting the camera mid-region creates a hard cut.
    const previousRegion = previousShot
      ? findRegion(config, previousShot.thumbnailZoomTo)
      : null;
    const transition = resolveTransition(shot, config.thumbnail.defaultTransition);
    const zoomFadeEnabled = shot.sceneFade ?? config.sceneFadeEnabled ?? true;
    if (shot.imageUrl || shot.videoUrl) {
      console.info('[scene router] thumbnail-zoom won over row image', {
        shotIndex,
        regionId: targetRegion.id,
        regionLabel: targetRegion.label,
        hadRowImage: Boolean(shot.imageUrl),
        hadRowVideo: Boolean(shot.videoUrl),
      });
    }
    return (
      <ThumbnailZoomScene
        durationInFrames={durationInFrames}
        brand={brand}
        thumbnail={config.thumbnail}
        region={targetRegion}
        previousRegion={previousRegion}
        transition={transition}
        fadeEnabled={zoomFadeEnabled}
        paddingPct={shot.regionZoomPaddingPct}
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
  // Phase 2 of _plans/2026-05-25-style-aware-overlay-text.md — map
  // the doc-level style id to the LowerThird's glyph variant. The
  // mapping lives here (one site, one mapping table) rather than
  // inside each scene component so adding a future built-in with its
  // own on-screen-text treatment is a single-line change.
  const lowerThirdVariant = config.styleId === 'doodle_explainer_2' ? 'doodle-yellow' : 'default';
  switch (shot.sceneType) {
    case 'title-card':
      return <TitleCardScene {...props} />;
    case 'text-reveal':
      return <TextRevealScene {...props} />;
    case 'icon-scene':
      return <IconScene {...props} />;
    case 'screen-mockup':
      return (
        <ScreenMockupScene
          {...props}
          suppressLowerThird={shot.suppressLowerThird ?? suppressLowerThirds}
          lowerThirdVariant={lowerThirdVariant}
        />
      );
    case 'outro':
      return <OutroScene {...props} />;
    case 'b-roll':
    case 'split-scene':
    default:
      return (
        <BRollScene
          {...props}
          shotIndex={shotIndex}
          suppressLowerThird={shot.suppressLowerThird ?? suppressLowerThirds}
          lowerThirdVariant={lowerThirdVariant}
        />
      );
  }
};
