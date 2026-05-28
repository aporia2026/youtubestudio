/**
 * MotionScene — render path for paint_explainer_v1 rows whose
 * `shotKind === 'motion'`. Mounts the base image (or the mouth-removed
 * variant when the shot has a `mouth_swap` beat) and then layers each
 * `motionBeat` as a Remotion `<Sequence>` so it appears for exactly
 * its window of frames.
 *
 * Phased rollout (per §15 of the architecture plan):
 *   - PR 1 (this file): `<MouthSwap>` for `mouth_swap` beats.
 *     `<ScribbleDraw>`, `<LabelPopOn>`, `<PropSlideIn>`,
 *     `<MicroWiggle>`, `<RealPhotoPunchIn>` are wired in PR 2+.
 *   - Unrecognised beat kinds are skipped silently so the LLM can emit
 *     forward-compatible data before each renderer component lands.
 *
 * Carries over the standard ambient layers (LowerThird, SceneTransition)
 * from BRollScene so paint_explainer_v1 shots match doodle_explainer_2's
 * outer chrome — only the inner visual changes.
 */
import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  useVideoConfig,
} from 'remotion';
import { LowerThird, type LowerThirdVariant } from '../components/LowerThird';
import { MouthSwap } from '../components/MouthSwap';
import { SceneTransition } from '../components/SceneTransition';
import { constantRateVisemeSequence } from '../../lib/viseme-from-alignment';
import type { BrandKit, VideoShot } from '../types';

interface MotionSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  suppressLowerThird?: boolean;
  fadeEnabled?: boolean;
  lowerThirdVariant?: LowerThirdVariant;
}

export const MotionScene: React.FC<MotionSceneProps & { shotIndex?: number }> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
  suppressLowerThird = false,
  fadeEnabled = true,
  lowerThirdVariant = 'doodle-yellow',
}) => {
  const { fps } = useVideoConfig();

  // ─── Beat partitioning ───────────────────────────────────────────
  //
  // Walk `motionBeats` once and split into recognised vs. unknown.
  // Recognised kinds get specific Remotion components below; unknown
  // kinds are dropped so the LLM can emit forward-compatible motion
  // data without breaking renders.
  const beats = shot.motionBeats ?? [];
  const mouthSwapBeats = useMemo(
    () => beats.filter((b) => b.kind === 'mouth_swap'),
    [beats],
  );

  // Has the pipeline produced the mouth-removed companion for this
  // shot? When yes, use it as the bottom layer so the procedural
  // mouth PNG composites over a face that's already had its mouth
  // erased. When no, fall back to the regular image — MouthSwap's
  // mouth PNG will sit on top of the original mouth, which is
  // imperfect but better than skipping motion entirely. Logged once
  // so a debug-from-symptoms session can find the cause.
  const baseForMouthSwap = shot.mouthRemovedUrl || shot.imageUrl;
  const mountMouthSwap = Boolean(baseForMouthSwap) && mouthSwapBeats.length > 0;

  if (shotIndex < 5) {
    console.info('[paint-explainer-v1 motion-scene mounted]', {
      shotIndex,
      shotKind: shot.shotKind,
      characterId: shot.characterId,
      motionBeatsCount: beats.length,
      mouthSwapBeats: mouthSwapBeats.length,
      hasMouthRemovedUrl: Boolean(shot.mouthRemovedUrl),
      mountMouthSwap,
    });
  }

  // Background layer: the row's primary image when no mouth-swap is
  // mounted on top. When mouth-swap IS mounted, MouthSwap itself
  // renders the bottom (mouth-removed) base, so we skip this layer.
  const showBaseUnderneath = !mountMouthSwap && Boolean(shot.imageUrl);

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      {showBaseUnderneath && (
        <Img
          src={shot.imageUrl!}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {mouthSwapBeats.map((beat, idx) => {
        const beatStartFrame = Math.max(0, Math.round((beat.startMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        // PR 1 uses the constant-rate fallback for the viseme
        // sequence. PR 2 wires the alignment-driven sequence in by
        // accepting a precomputed `MouthState[]` on the shot. Each
        // beat gets its OWN sequence sized to its window so the
        // talking loop starts fresh on every beat boundary (closer
        // to real Paint-Explainer pacing than one continuous loop).
        const sequence = constantRateVisemeSequence({
          durationFrames: beatDurationFrames,
          fps,
          rateHz: 8,
        });
        return (
          <Sequence
            key={`mouth-swap-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <MouthSwap
              baseUrl={baseForMouthSwap!}
              sequence={sequence}
              diagnose={shotIndex < 5 && idx === 0}
            />
          </Sequence>
        );
      })}

      {/* Subtle bottom gradient — matches BRollScene's polish layer so
          paint_explainer_v1 shots blend with surrounding ones from
          other scene types. */}
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

      {shot.onScreenText && !suppressLowerThird && (
        <LowerThird
          text={shot.onScreenText}
          brand={brand}
          totalFrames={durationInFrames}
          delay={12}
          exitBeforeEnd={15}
          variant={lowerThirdVariant}
        />
      )}

      <SceneTransition
        fadeIn={fadeEnabled}
        fadeOut={fadeEnabled}
        totalFrames={durationInFrames}
        durationInFrames={8}
      />
    </AbsoluteFill>
  );
};
