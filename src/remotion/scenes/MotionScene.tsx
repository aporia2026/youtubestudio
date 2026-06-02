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
import { LabelPopOn } from '../components/LabelPopOn';
import { type LowerThirdVariant } from '../components/LowerThird';
import { OnScreenTextLayer } from '../components/OnScreenTextLayer';
import { MicroWiggle } from '../components/MicroWiggle';
import { MouthSwap } from '../components/MouthSwap';
import { PropSlideIn, type PropSlideInDirection } from '../components/PropSlideIn';
import { RealPhotoPunchIn } from '../components/RealPhotoPunchIn';
import { ScribbleDraw, type ScribbleDrawDirection } from '../components/ScribbleDraw';
import { SceneTransition } from '../components/SceneTransition';
import {
  constantRateVisemeSequence,
  visemeSequenceFromAlignment,
} from '../../lib/viseme-from-alignment';
import { onsetFromAlignment } from '../../lib/onset-from-alignment';
import type { BrandKit, PaintExplainerV1Settings, VideoShot } from '../types';

interface MotionSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  suppressLowerThird?: boolean;
  fadeEnabled?: boolean;
  lowerThirdVariant?: LowerThirdVariant;
  /** Resolved paint_explainer_v1 settings forwarded by the SceneRouter.
   *  When undefined (legacy / non-paint_explainer_v1 callers reaching
   *  this scene by accident), MotionScene falls back to the same
   *  hardcoded defaults the resolver applies. */
  paintSettings?: Required<PaintExplainerV1Settings>;
  /** Per-doc prop cache (propPromptHint → URL). When set, MotionScene
   *  resolves prop_slide beats by looking up
   *  beat.payload.propPromptHint here before falling back to
   *  beat.payload.assetUrl. Populated by `productionDocToVideoConfig`
   *  from `doc.paint_explainer_v1_prop_cache`. */
  propCache?: Record<string, string>;
}

export const MotionScene: React.FC<MotionSceneProps & { shotIndex?: number }> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
  suppressLowerThird = false,
  fadeEnabled = true,
  lowerThirdVariant = 'doodle-yellow',
  paintSettings,
  propCache,
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
  const realPhotoPunchBeats = useMemo(
    () => beats.filter((b) => b.kind === 'real_photo_punch'),
    [beats],
  );
  const labelPopBeats = useMemo(
    () => beats.filter((b) => b.kind === 'label_pop'),
    [beats],
  );
  const scribbleDrawBeats = useMemo(
    () => beats.filter((b) => b.kind === 'scribble_draw'),
    [beats],
  );
  const microWiggleBeats = useMemo(
    () => beats.filter((b) => b.kind === 'micro_wiggle'),
    [beats],
  );
  const propSlideBeats = useMemo(
    () => beats.filter((b) => b.kind === 'prop_slide'),
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

        // Two viseme paths, branched per the doc setting and the
        // availability of an alignment word slice:
        //
        //  1. Alignment-driven (preferred). When the
        //     `use_alignment_driven_visemes` setting is on AND the
        //     shot carries `shot.visemeWords` (computed by
        //     `productionDocToVideoConfig` from the project's
        //     forced-alignment JSON), the mouth state follows the
        //     spoken words frame-by-frame: 'open' during a word,
        //     'mid' between words, 'closed' on silences > 500 ms.
        //     This is what makes the talking feel match the audio.
        //
        //  2. Constant-rate fallback. When alignment is unavailable
        //     OR the user has explicitly disabled alignment-driven
        //     visemes for debugging, the beat cycles mid ↔ open at
        //     the configured rate (default 8 Hz, range 6–12).
        //
        // The beat's window is a SUBSET of the shot's window; we
        // pass the shot's full word slice to the helper and let it
        // re-clip to the beat boundary. Per-beat sequences keep the
        // talking loop fresh on every beat instead of running one
        // continuous loop across the whole shot — closer to the
        // genre's pacing.
        const beatAbsoluteStartMs = shot.startMs + beat.startMs;
        const useAlignment =
          (paintSettings?.use_alignment_driven_visemes ?? true)
          && Array.isArray(shot.visemeWords)
          && shot.visemeWords.length > 0;
        const sequence = useAlignment
          ? visemeSequenceFromAlignment({
              rowStartMs: beatAbsoluteStartMs,
              rowDurationMs: beat.durationMs,
              words: shot.visemeWords!,
              fps,
            })
          : constantRateVisemeSequence({
              durationFrames: beatDurationFrames,
              fps,
              rateHz: paintSettings?.mouth_swap_fps_fallback ?? 8,
            });

        // Diagnostic log fires once per shot at the first beat so
        // the cron tail / browser console can grep which viseme
        // source actually drove each shot. Important for debugging
        // "the mouth isn't following the audio" — telemetry says
        // whether alignment was even attempted.
        if (shotIndex < 5 && idx === 0) {
          console.info('[paint-explainer-v1 viseme]', {
            shotIndex,
            source: useAlignment ? 'alignment' : 'constant-rate',
            beat_absolute_start_ms: beatAbsoluteStartMs,
            beat_duration_ms: beat.durationMs,
            words_in_slice: shot.visemeWords?.length ?? 0,
            rate_hz: paintSettings?.mouth_swap_fps_fallback ?? 8,
            setting_alignment_driven:
              paintSettings?.use_alignment_driven_visemes ?? true,
          });
        }

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
              anchor={shot.mouthAnchor}
              diagnose={shotIndex < 5 && idx === 0}
            />
          </Sequence>
        );
      })}

      {/* Prop-slide beats. The prop PNG slides in from the chosen
          side (default 'right') to its anchor, settles with a soft
          spring. URL resolution: beat.payload.assetUrl wins; the
          renderer renders nothing when neither the LLM nor the
          (deferred) prop-generation pipeline supplies a URL — no
          held frames, no broken-image icons. */}
      {propSlideBeats.map((beat, idx) => {
        const beatStartFrame = Math.max(0, Math.round((beat.startMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        // URL resolution: beat.payload.assetUrl wins (LLM-supplied
        // direct URL). Else look up beat.payload.propPromptHint in
        // the doc's prop cache (pipeline-generated transparent prop
        // PNG). Else skip — no URL means no render, but no broken
        // image icon either.
        const promptHint = beat.payload?.propPromptHint;
        const url =
          beat.payload?.assetUrl
          ?? (promptHint && propCache ? propCache[promptHint] : undefined);
        if (!url) {
          if (shotIndex < 5 && idx === 0) {
            console.info('[paint-explainer-v1 prop-slide] skipped — no URL', {
              shotIndex,
              beat_idx: idx,
              has_payload_assetUrl: Boolean(beat.payload?.assetUrl),
              has_prompt_hint: Boolean(promptHint),
              prop_cache_hit: Boolean(promptHint && propCache?.[promptHint]),
            });
          }
          return null;
        }
        const rawDirection = (beat.payload as { fromDirection?: string } | undefined)?.fromDirection;
        const fromDirection: PropSlideInDirection =
          rawDirection === 'left' || rawDirection === 'top' || rawDirection === 'bottom'
            ? rawDirection
            : 'right';
        return (
          <Sequence
            key={`prop-slide-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <PropSlideIn
              url={url}
              anchor={beat.anchor}
              fromDirection={fromDirection}
              diagnose={shotIndex < 5 && idx === 0}
            />
          </Sequence>
        );
      })}

      {/* Micro-wiggle beats. Each beat mounts a tiny rotation /
          translation transform on an overlay layer that covers the
          base, so the character body subtly sways for the beat's
          duration. The wiggle is frame-deterministic (no Math.random)
          so preview and Lambda renders stay byte-identical. */}
      {microWiggleBeats.map((beat, idx) => {
        const beatStartFrame = Math.max(0, Math.round((beat.startMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        if (shotIndex < 5 && idx === 0) {
          console.info('[paint-explainer-v1 micro-wiggle]', {
            shotIndex,
            beat_idx: idx,
            duration_ms: beat.durationMs,
            base_for_wiggle: baseForMouthSwap ? 'mouth-removed' : shot.imageUrl ? 'image' : 'none',
          });
        }
        return (
          <Sequence
            key={`micro-wiggle-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <MicroWiggle diagnose={shotIndex < 5 && idx === 0}>
              {/* Render a copy of the base image inside the wiggle
                  wrapper. The static base / mouth-swap below this
                  layer keeps rendering, but the wiggling copy on top
                  occludes it during the beat — the viewer sees the
                  wiggle, not a double-image. */}
              {(baseForMouthSwap || shot.imageUrl) && (
                <img
                  src={(baseForMouthSwap || shot.imageUrl)!}
                  alt=""
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              )}
            </MicroWiggle>
          </Sequence>
        );
      })}

      {/* Scribble-draw beats. The component renders a white-cover
          rectangle that progressively masks AWAY from the base image
          beneath it, simulating "drawing in progress." Mounted ABOVE
          the static base / mouth-swap layer but BELOW labels and
          real-photo punches — labels should land on the revealed
          canvas, not on the white cover. Direction comes from
          beat.payload?.direction (one of 'left-to-right' /
          'top-to-bottom' / 'radial-out'); default left-to-right. */}
      {scribbleDrawBeats.map((beat, idx) => {
        const beatStartFrame = Math.max(0, Math.round((beat.startMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        const rawDirection = (beat.payload as { direction?: string } | undefined)?.direction;
        const direction: ScribbleDrawDirection =
          rawDirection === 'top-to-bottom' || rawDirection === 'radial-out'
            ? rawDirection
            : 'left-to-right';
        if (shotIndex < 5 && idx === 0) {
          console.info('[paint-explainer-v1 scribble-draw]', {
            shotIndex,
            beat_idx: idx,
            direction,
            duration_ms: beat.durationMs,
          });
        }
        return (
          <Sequence
            key={`scribble-draw-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <ScribbleDraw
              durationInFrames={beatDurationFrames}
              direction={direction}
              coverColor={brand.backgroundColor}
              diagnose={shotIndex < 5 && idx === 0}
            />
          </Sequence>
        );
      })}

      {/* Real-photo punch-in beats. URL resolution order:
            1. beat.payload.assetUrl (LLM-supplied per beat)
            2. shot.overlay?.url (the existing auto-fetched stock photo
               populated by the `overlay_stock_terms` pipeline).
          A beat with neither resolution is silently skipped — the
          renderer never holds the frame waiting for an asset that
          isn't coming. */}
      {realPhotoPunchBeats.map((beat, idx) => {
        const beatStartFrame = Math.max(0, Math.round((beat.startMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        const url = beat.payload?.assetUrl ?? shot.overlay?.url;
        if (!url) {
          if (shotIndex < 5 && idx === 0) {
            console.info('[paint-explainer-v1 real-photo-punch] skipped — no URL', {
              shotIndex,
              beat_idx: idx,
              has_payload_assetUrl: Boolean(beat.payload?.assetUrl),
              has_shot_overlay_url: Boolean(shot.overlay?.url),
            });
          }
          return null;
        }
        return (
          <Sequence
            key={`real-photo-punch-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <RealPhotoPunchIn
              url={url}
              anchor={beat.anchor}
              diagnose={shotIndex < 5 && idx === 0}
            />
          </Sequence>
        );
      })}

      {/* Label-pop beats. Each beat carries the label text in
          beat.payload.text and the anchor placement on beat.anchor.
          When alignment data is available for the shot (visemeWords
          populated), the label's startMs is rebased onto the actual
          word's onset so the pop-on lands ON the spoken syllable —
          floating-near-the-word reads as out-of-sync; landing-on-it
          reads as deliberate. */}
      {labelPopBeats.map((beat, idx) => {
        const labelText = (beat.payload?.text ?? '').trim();
        if (!labelText) return null;
        const rebasedStartMs = onsetFromAlignment({
          words: shot.visemeWords,
          labelText,
          shotStartMs: shot.startMs,
          fallbackStartMs: beat.startMs,
        });
        const beatStartFrame = Math.max(0, Math.round((rebasedStartMs / 1000) * fps));
        const beatDurationFrames = Math.max(
          1,
          Math.round((beat.durationMs / 1000) * fps),
        );
        if (shotIndex < 5 && idx === 0) {
          console.info('[paint-explainer-v1 label-pop]', {
            shotIndex,
            text_head: labelText.slice(0, 40),
            llm_start_ms: beat.startMs,
            rebased_start_ms: rebasedStartMs,
            source: rebasedStartMs === beat.startMs ? 'fallback' : 'alignment-onset',
            has_alignment: Array.isArray(shot.visemeWords),
          });
        }
        return (
          <Sequence
            key={`label-pop-${idx}`}
            from={beatStartFrame}
            durationInFrames={beatDurationFrames}
            layout="none"
          >
            <LabelPopOn
              text={labelText}
              anchor={beat.anchor}
              colorHex={paintSettings?.label_color_hex}
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

      {/* PR 6 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
          OnScreenTextLayer routes legacy single-text rows to LowerThird
          and multi-block rows to per-block PositionedTextBlock. */}
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
