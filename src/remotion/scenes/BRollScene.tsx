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
}

// Cycle Ken Burns directions based on shot index to avoid repetition
const KB_DIRECTIONS: VideoShot['kenBurnsDirection'][] = [
  'zoom-in', 'pan-left', 'pan-right', 'zoom-out', 'pan-up', 'pan-down',
];

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
    return <FallbackBRoll shot={shot} durationInFrames={durationInFrames} brand={brand} />;
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

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor }}>
      {useVideo ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <OffthreadVideo
            src={shot.videoUrl!}
            // Mute: the production doc's voiceover is the sole audio source;
            // Kie clips ship with model-generated audio we never want bleeding
            // through. (Kling i2v writes silent clips anyway, but Kling 2.6
            // with sound=true / Veo 3 with audio could leak otherwise.)
            muted
            onError={() => setVideoError(true)}
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

      <SceneTransition fadeIn fadeOut totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};

// ─── Fallback when no image ────────────────────────────────────────────────────

const FallbackBRoll: React.FC<{ shot: VideoShot; durationInFrames: number; brand: BrandKit }> = ({
  shot,
  durationInFrames,
  brand,
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

      <SceneTransition fadeIn fadeOut totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};
