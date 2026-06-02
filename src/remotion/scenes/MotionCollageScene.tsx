/**
 * MotionCollageScene — render path for doodle_explainer_2 rows whose
 * `shotKind === 'motion_collage'`. Plays the pipeline-generated
 * per-panel images as HARD-CUT keyframes across the shot's window so
 * the brain reads them as continuous motion (a running character, a
 * falling object, a logo assembling piece-by-piece).
 *
 * The panels live on `shot.motionCollagePanelUrls` (populated by
 * `generateMotionCollage` in the auto-pipeline) and were all drawn in
 * one image-model call — that's what guarantees visual coherence
 * between frames (same character, same camera, same background).
 *
 * Duration math: equal subdivision of `durationInFrames` across N
 * panels, with the remainder absorbed by the last panel so the total
 * exactly equals the shot window. NO fades between panels — fades
 * defeat the keyframe-animation feel and read as slideshow. The outer
 * SceneTransition still applies the row-level entry/exit fade per the
 * doc + per-row scene_fade resolution.
 *
 * Fallback path: when `motionCollagePanelUrls` is missing or empty
 * (pipeline hasn't run yet OR generation failed), render the row's
 * `imageUrl` as a held still — the pipeline mirrors panel 0 into
 * imageUrl on success, so a successful row shows the first keyframe
 * even when the panels haven't been threaded through. Failed rows
 * with no imageUrl show the brand background; never broken-image
 * icons, never scary warnings.
 *
 * See _plans/2026-05-31-doodle-explainer-2-motion-collage.md.
 */
import React from 'react';
import { AbsoluteFill, Img, Sequence, useVideoConfig } from 'remotion';
import { type LowerThirdVariant } from '../components/LowerThird';
import { OnScreenTextLayer } from '../components/OnScreenTextLayer';
import { SceneTransition } from '../components/SceneTransition';
import { planMotionCollageWindows } from '../motion-collage-frame-math';
import type { BrandKit, VideoShot } from '../types';

interface MotionCollageSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  suppressLowerThird?: boolean;
  fadeEnabled?: boolean;
  lowerThirdVariant?: LowerThirdVariant;
}

export const MotionCollageScene: React.FC<
  MotionCollageSceneProps & { shotIndex?: number }
> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
  suppressLowerThird = false,
  fadeEnabled = true,
  lowerThirdVariant = 'doodle-yellow',
}) => {
  const { fps } = useVideoConfig();
  const panels = shot.motionCollagePanelUrls ?? [];
  const N = panels.length;

  // Fallback path: no panels yet (pipeline hasn't generated, or
  // generation failed). Render the row's regular image as a held
  // frame so the editor preview isn't blank. Logged once per shot
  // (first 5 shots only) so a debug session can find the cause
  // without spamming the console at scale.
  if (N === 0) {
    if (shotIndex < 5) {
      console.info('[motion-collage] fallback to single image — no panels', {
        shotIndex,
        hasImageUrl: Boolean(shot.imageUrl),
      });
    }
    return (
      <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
        {shot.imageUrl && (
          <Img
            src={shot.imageUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        <OnScreenTextLayer
          shot={shot}
          brand={brand}
          durationInFrames={durationInFrames}
          suppressLowerThird={suppressLowerThird}
          variant={lowerThirdVariant}
        />
        <SceneTransition
          fadeIn={fadeEnabled}
          fadeOut={fadeEnabled}
          totalFrames={durationInFrames}
          durationInFrames={8}
        />
      </AbsoluteFill>
    );
  }

  // Per-panel timing math lives in `planMotionCollageWindows` —
  // floor-divide the shot window across N panels; the last panel
  // absorbs the remainder so the total exactly equals
  // `durationInFrames`. Pure function; tests cover the corner cases.
  const windows = planMotionCollageWindows(durationInFrames, N);

  if (shotIndex < 5) {
    console.info('[motion-collage mounted]', {
      shotIndex,
      panel_count: N,
      first_panel_frames: windows[0]?.durationInFrames,
      last_panel_frames: windows[windows.length - 1]?.durationInFrames,
      duration_frames: durationInFrames,
      duration_seconds: Math.round((durationInFrames / fps) * 100) / 100,
    });
  }

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      {panels.map((url, idx) => {
        const w = windows[idx];
        // Defensive — when `durationInFrames < N`, early panels land
        // at 0 frames and Remotion <Sequence> rejects zero-duration
        // windows. The pipeline's `min_per_frame_ms` settings gate
        // blocks this case BEFORE generation; the guard here is for
        // safety in the editor preview where durations can be
        // hand-edited to unrealistic values.
        if (!w || w.durationInFrames <= 0) return null;
        // Per-panel transform — when the user shifted the image
        // within this panel via the lightbox sliders (user ask
        // 2026-06-02), apply CSS translate + scale on top of the
        // existing objectFit:cover layout. transformOrigin stays at
        // center so positive Y translates the image DOWN within the
        // viewport (revealing more of the top of the source) and
        // scale grows from center. Absent / null entries render
        // identity (the default). Bounds already clamped at the
        // payload boundary.
        const tx = shot.motionCollagePanelTransforms?.[idx];
        const txStyle: React.CSSProperties = {};
        if (tx) {
          const xPct = typeof tx.x_pct === 'number' && Number.isFinite(tx.x_pct) ? tx.x_pct : 0;
          const yPct = typeof tx.y_pct === 'number' && Number.isFinite(tx.y_pct) ? tx.y_pct : 0;
          const scalePct =
            typeof tx.scale_pct === 'number' && Number.isFinite(tx.scale_pct) ? tx.scale_pct : 100;
          if (xPct !== 0 || yPct !== 0 || scalePct !== 100) {
            txStyle.transform = `translate(${xPct}%, ${yPct}%) scale(${scalePct / 100})`;
            txStyle.transformOrigin = 'center center';
          }
        }
        return (
          <Sequence
            key={`panel-${idx}`}
            from={w.from}
            durationInFrames={w.durationInFrames}
            layout="none"
          >
            <Img
              src={url}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                ...txStyle,
              }}
            />
          </Sequence>
        );
      })}

      <OnScreenTextLayer
        shot={shot}
        brand={brand}
        durationInFrames={durationInFrames}
        suppressLowerThird={suppressLowerThird}
        variant={lowerThirdVariant}
      />

      <SceneTransition
        fadeIn={fadeEnabled}
        fadeOut={fadeEnabled}
        totalFrames={durationInFrames}
        durationInFrames={8}
      />
    </AbsoluteFill>
  );
};
