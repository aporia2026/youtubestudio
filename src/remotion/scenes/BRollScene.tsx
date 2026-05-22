import React, { useState } from 'react';
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { KenBurns } from '../components/KenBurns';
import { LowerThird } from '../components/LowerThird';
import { FloatingElement } from '../components/FloatingElement';
import { SceneTransition } from '../components/SceneTransition';
import { VideoShot, BrandKit } from '../types';

interface BRollSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  /** When true, skip the lower-third on-screen-text overlay entirely.
   *  Used when the OST is already baked into the AI image so a
   *  Remotion overlay would just duplicate it. Defaults false. */
  suppressLowerThird?: boolean;
  /** When false, suppress the scene-to-scene cross fade (no opening
   *  fade-in from black, no closing fade-out). Defaults to `true`. */
  fadeEnabled?: boolean;
}

// Cycle Ken Burns directions based on shot index to avoid repetition
const KB_DIRECTIONS: VideoShot['kenBurnsDirection'][] = [
  'zoom-in', 'pan-left', 'pan-right', 'zoom-out', 'pan-up', 'pan-down',
];

/** Sanity-clamp a numeric transform field. Returns the clamped value
 *  when finite + in-range, otherwise `fallback`. Keeps malformed
 *  payloads (NaN, ±Infinity, out-of-range overrides) from blowing the
 *  CSS transform string into something the browser can't parse. */
function clampNum(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * B-Roll scene — three render paths in priority order:
 *
 *   1. `videoUrl` present and playable → render <OffthreadVideo> (an animated
 *      clip generated via the B-roll image-to-video pipeline). Clip duration
 *      may be shorter than the shot's `durationInFrames`; OffthreadVideo's
 *      default behaviour freezes the last frame for the remainder.
 *
 *   2. `imageUrl` present → render the still with a Ken Burns pan/zoom. This
 *      is the historical default and remains the path for rows the user has
 *      not animated (or rows with the per-doc Animate toggle off).
 *
 *   3. No image → fall through to `FallbackBRoll` (stylized text card).
 */
export const BRollScene: React.FC<BRollSceneProps & { shotIndex?: number }> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
  suppressLowerThird = false,
  fadeEnabled = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [imgError, setImgError] = useState(false);
  const [videoError, setVideoError] = useState(false);

  const direction = shot.kenBurnsDirection ?? KB_DIRECTIONS[shotIndex % KB_DIRECTIONS.length];

  // Video URL: only https://; blob: URLs from Vercel Blob writes don't survive
  // page reload (same caveat as the still-image guard).
  const useVideo = shot.videoUrl && !videoError && !shot.videoUrl.startsWith('blob:');
  const useImage = shot.imageUrl && !imgError && !shot.imageUrl.startsWith('blob:');

  if (!useVideo && !useImage) {
    return <FallbackBRoll shot={shot} durationInFrames={durationInFrames} brand={brand} fadeEnabled={fadeEnabled} />;
  }

  // Letterbox mode: when the row has a section title + letterbox layout,
  // the parent has already shrunk this scene's container to fit below the
  // stripe (1920 × ~940). Cropping with object-fit:cover / Ken Burns inside
  // that smaller box wastes the geometry — overflow gets clipped and the
  // user sees the same "title eating the image" symptom letterbox was
  // supposed to solve. So in letterbox mode we use object-fit:contain and
  // skip Ken Burns: every source pixel survives, brand.backgroundColor
  // (overridden to pillarboxColor by the composition) shows in any unfilled
  // area. See _plans/2026-05-17-section-title-letterbox-and-overlay-blending.md.
  const isLetterbox =
    Boolean(shot.sectionTitle) && (shot.sectionTitleLayout ?? 'letterbox') === 'letterbox';

  // Fit the clip's intrinsic duration to the scene's. Without this, a
  // 10s clip in a 7s scene would cut at 7s (paid 3s of clip discarded)
  // and a 10s clip in a 15s scene would freeze the last frame at 10s
  // (image stops moving while narration continues). Both are visible
  // failures of polish. Solution: compute playbackRate = clipSec/sceneSec
  // and let Remotion stretch / compress the clip to fit. Clamp the
  // result so extreme mismatches degrade gracefully instead of producing
  // visibly jittery (>2×) or smeared output. See plan
  // `_plans/2026-05-17-clip-duration-fit.md`.
  //
  // 2026-05-20: lowered PLAYBACK_RATE_MIN from 0.5 → 0.25 after rendered
  // QA on an 8-min video found 47 freeze-tail segments totalling 7.7%
  // of the duration — clips running out before scenes ended because
  // 0.5× couldn't stretch a 5s clip across a 14s scene. 0.25× lets a
  // 5s clip fill a 20s scene. The trade is more visible slow-motion in
  // extreme mismatches; slow-mo still beats a stuck last frame because
  // "stuff is happening on screen" reads as alive while a held frame
  // reads as broken.
  const sceneSeconds = durationInFrames / fps;
  // Fallback to 10s when the clip's duration didn't make it through
  // (legacy rows pre-duration plumbing, or DB hydration returning null).
  // 10s matches the default tier so the fallback math approximates the
  // dominant case.
  const clipSeconds = shot.videoDurationSeconds && shot.videoDurationSeconds > 0
    ? shot.videoDurationSeconds
    : 10;
  // Editor's head + tail trim narrows the source clip's playable
  // range. Effective clip duration = clipSeconds - trimStart - trimEnd.
  // Floor at 0.1s so a runaway trim can't divide by zero or produce
  // a NaN playback rate. The startFrom prop on OffthreadVideo handles
  // the head; this rate change handles the tail by speeding the clip
  // up enough that the trimmed-out frames never play.
  const trimStartSec = (shot.trimStartMs ?? 0) / 1000;
  const trimEndSec = (shot.trimEndMs ?? 0) / 1000;
  const effectiveClipSeconds = Math.max(0.1, clipSeconds - trimStartSec - trimEndSec);
  const PLAYBACK_RATE_MIN = 0.25;
  const PLAYBACK_RATE_MAX = 2.0;
  const rawPlaybackRate = sceneSeconds > 0 ? effectiveClipSeconds / sceneSeconds : 1;
  const playbackRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, rawPlaybackRate));
  // One-shot diagnostic so a viewer seeing "the clip looks weird" can
  // reason from the console instead of guessing. Frame 0 only — a 7s
  // scene at 30fps shouldn't spam 210 log lines.
  if (useVideo && frame === 0) {
    console.info('[broll playback fit]', {
      sceneSeconds: Number(sceneSeconds.toFixed(2)),
      clipSeconds,
      trimStartSec,
      trimEndSec,
      effectiveClipSeconds: Number(effectiveClipSeconds.toFixed(2)),
      rawPlaybackRate: Number(rawPlaybackRate.toFixed(3)),
      playbackRate: Number(playbackRate.toFixed(3)),
      clamped: rawPlaybackRate !== playbackRate,
    });
  }

  // Static zoom applied as a wrapper transform so it multiplies on top of
  // any animated transform (Ken Burns, B-roll playback) instead of replacing
  // it. zoomScale === 1 ⇒ no zoom; the wrapper renders as a no-op. Clamped
  // to [0.5, 2.0] so a corrupt doc value can't push the visual completely
  // off-screen or so large that the browser drops frames re-compositing.
  const rawZoom = typeof shot.sceneZoom === 'number' && Number.isFinite(shot.sceneZoom)
    ? shot.sceneZoom
    : 100;
  const zoomScale = Math.max(0.5, Math.min(2.0, rawZoom / 100));
  const zoomWrapperStyle: React.CSSProperties =
    zoomScale === 1
      ? {}
      : { transform: `scale(${zoomScale})`, transformOrigin: 'center center' };

  // Canva-style free-transform (Batch A of
  // _plans/2026-05-23-editor-canva-transform.md). Composes INSIDE the
  // scene_zoom wrapper so the renderer is identity-equivalent for rows
  // that don't set any free-transform fields. Clamping protects against
  // malformed payloads: x/y are percentages of canvas size, scale is
  // a percent of natural fit, rotation is degrees (modulo'd visually).
  const freeXPct = clampNum(shot.imageXPct, -200, 200, 0);
  const freeYPct = clampNum(shot.imageYPct, -200, 200, 0);
  const freeScalePct = clampNum(shot.imageScalePct, 10, 400, 100);
  const freeRotDeg = clampNum(shot.imageRotationDeg, -3600, 3600, 0);
  const freeTransformIdentity =
    freeXPct === 0 && freeYPct === 0 && freeScalePct === 100 && freeRotDeg === 0;
  const freeTransformStyle: React.CSSProperties = freeTransformIdentity
    ? {}
    : {
        transform: `translate(${freeXPct}%, ${freeYPct}%) scale(${freeScalePct / 100}) rotate(${freeRotDeg}deg)`,
        transformOrigin: 'center center',
      };

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      <AbsoluteFill style={zoomWrapperStyle}>
      <AbsoluteFill style={freeTransformStyle}>
      {useVideo ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <OffthreadVideo
            src={shot.videoUrl!}
            // Editor's head-trim: when set, skip this many seconds at
            // the start of the source clip. Defaults to 0 (no trim).
            // Tail trim (`trimEndMs`) is data-only in v1 — wiring it
            // requires a Sequence-level duration cap that the BRollScene
            // doesn't currently own; the next renderer-integration pass
            // will plumb it.
            startFrom={
              typeof shot.trimStartMs === 'number' && shot.trimStartMs > 0
                ? Math.round((shot.trimStartMs / 1000) * fps)
                : 0
            }
            // Mute: the production doc's voiceover is the sole audio source;
            // Kie clips ship with model-generated audio we never want bleeding
            // through. (Kling i2v writes silent clips anyway, but Kling 2.6
            // with sound=true / Veo 3 with audio could leak otherwise.)
            muted
            playbackRate={playbackRate}
            // pauseWhenBuffering: halt the whole player while this clip
            // is loading instead of letting playback drift past it. In
            // the preview, missing this causes the composition-level
            // voiceover to pop/dip at scene boundaries as the browser
            // allocates decoder resources for the newly-mounted video.
            pauseWhenBuffering
            onError={(e) => {
              // 2026-05-20: log the actual decode/fetch error before
              // falling back to the still-image path. Renders that
              // came back stills-only despite valid videoUrls in the
              // config left no trace of WHY OffthreadVideo gave up;
              // this captures the message and surfaces it in the
              // Vercel function log for the render invocation.
              const detail =
                typeof e === 'object' && e !== null && 'message' in e
                  ? String((e as { message: unknown }).message)
                  : String(e);
              console.error('[broll OffthreadVideo error]', {
                shotIndex,
                durationInFrames,
                hasImageFallback: Boolean(shot.imageUrl),
                videoUrlHead: shot.videoUrl?.slice(0, 120),
                detail,
              });
              setVideoError(true);
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: isLetterbox ? 'contain' : 'cover',
            }}
          />
        </AbsoluteFill>
      ) : isLetterbox ? (
        // Static image at object-fit:contain — every pixel of the source
        // fits inside the letterbox container, no Ken Burns crop.
        <Img
          src={shot.imageUrl!}
          onError={() => setImgError(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      ) : (
        <KenBurns
          imageUrl={shot.imageUrl!}
          durationInFrames={durationInFrames}
          direction={direction}
          onError={() => setImgError(true)}
        />
      )}
      </AbsoluteFill>
      </AbsoluteFill>

      {/* Subtle dark gradient at bottom for text readability */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 220,
          background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Lower third — skipped when suppressLowerThird is on (e.g. the
          OST is baked into the AI image and the user doesn't want a
          second Remotion-rendered overlay duplicating it). */}
      {shot.onScreenText && !suppressLowerThird && (
        <LowerThird
          text={shot.onScreenText}
          brand={brand}
          totalFrames={durationInFrames}
          delay={12}
          exitBeforeEnd={15}
        />
      )}

      <SceneTransition fadeIn={fadeEnabled} fadeOut={fadeEnabled} totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};

// ─── Fallback when no image ────────────────────────────────────────────────────

const FallbackBRoll: React.FC<{ shot: VideoShot; durationInFrames: number; brand: BrandKit; fadeEnabled?: boolean }> = ({
  shot,
  durationInFrames,
  brand,
  fadeEnabled = true,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${brand.backgroundColor} 0%, ${brand.secondaryColor}22 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px',
      }}
    >
      {/* Decorative background dots pattern */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(${brand.primaryColor}18 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
          opacity: 0.5,
        }}
      />

      <div style={{ opacity, textAlign: 'center', position: 'relative', zIndex: 1 }}>
        {shot.onScreenText && (
          <div
            style={{
              fontFamily: brand.titleFontFamily,
              fontSize: 72,
              fontWeight: 800,
              color: brand.textColor,
              lineHeight: 1.2,
              letterSpacing: -2,
            }}
          >
            {shot.onScreenText}
          </div>
        )}
        {shot.scriptText && (
          <div
            style={{
              fontFamily: brand.fontFamily,
              fontSize: 40,
              fontWeight: 400,
              color: brand.textColor + 'BB',
              marginTop: 24,
              maxWidth: 900,
              lineHeight: 1.5,
            }}
          >
            {shot.scriptText.slice(0, 120)}{shot.scriptText.length > 120 ? '…' : ''}
          </div>
        )}
      </div>

      <SceneTransition fadeIn={fadeEnabled} fadeOut={fadeEnabled} totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};
