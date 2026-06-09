/**
 * ZennScene — render path for `zenn_v1` rows whose `zennMode === 'scene'`
 * (Mode B). Composes a flat-fill scene world: a CSS color-band
 * background painted from the doc-level world palette plus the
 * canonical character PNG looked up by `zennCharacterId` from the
 * doc-level character bank.
 *
 * Phased rollout (per plan §5.5):
 *   - PR 3 (this file): background bands + character layer + scene
 *     transition. The two devices that carry every Mode B shot in
 *     the Zenn reference videos (Calhoun, Ancient Humans, Aliens,
 *     Titanic).
 *   - PR 4 adds canvas_reveal sibling-frame layers on top.
 *   - PR 5 adds static prop layers from the doc-level recurring
 *     props bank once the LLM emits per-shot prop hints.
 *   - PR 6 adds the red hand-lettered OST overlay.
 *
 * Mode A (`zennMode === 'stick'`) is NOT handled here — those rows
 * fall through to BRollScene because the Mode A look is already
 * baked into the AI-generated image by the style suffix. PR 4 will
 * route Mode A through this scene as well when canvas_reveal beats
 * land.
 *
 * Layer order, back to front:
 *   1. World background (CSS color bands)
 *   2. Static props bank (PR 5 stub)
 *   3. Character pose (Img layer)
 *   4. canvas_reveal layers (PR 4 stub)
 *   5. SceneTransition (cross-fade across shot boundaries)
 *
 * Pure layout helpers (resolveCharacterUrl, resolveWorldPalette,
 * worldBandLayout) are exported for unit testing — the rest of the
 * component is composition glue.
 */
import React from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { type LowerThirdVariant } from '../components/LowerThird';
import { SceneTransition } from '../components/SceneTransition';
import type { BrandKit, VideoConfig, VideoShot, ZennV1Settings } from '../types';
import {
  isRevealLayerRenderable,
  resolveRevealWindow,
  type CanvasRevealLayerInput,
} from '../canvas-reveal-math';
import { highlighterRgba, parseZennLabel } from '../zenn-label-parse';
import { normalizeZennCharacterId } from '../zenn-character-id';

// ─── canonical world palette defaults ───────────────────────────────
//
// Mirrors `WORLD_PALETTE_DEFAULTS` in
// `src/lib/auto-pipeline/stages/generate-zenn-v1-images.ts`. Re-stated
// here (not imported) because the pipeline module is server-only and
// pulls a postgres dependency that's unsafe to import inside a
// Remotion bundle. The two tables MUST stay in sync — the test suite
// pins the parity on both ends.

const WORLD_PALETTE_DEFAULTS: Record<
  'sky_only' | 'sky_ground' | 'room' | 'underwater',
  { sky_color_hex: string; ground_color_hex: string; wall_color_hex: string }
> = {
  sky_only: {
    sky_color_hex: '#FFFFFF',
    ground_color_hex: '#9E9E9E',
    wall_color_hex: '#E0E0E0',
  },
  sky_ground: {
    sky_color_hex: '#BFE4F3',
    ground_color_hex: '#F2D69A',
    wall_color_hex: '#E0E0E0',
  },
  room: {
    sky_color_hex: '#E8E8E8',
    ground_color_hex: '#9E9E9E',
    wall_color_hex: '#E8E8E8',
  },
  underwater: {
    sky_color_hex: '#1B4F72',
    ground_color_hex: '#0B2A4A',
    wall_color_hex: '#1F618D',
  },
};

/** Resolve the effective world palette for a Mode B shot. Layers
 *  doc-level user overrides over the canonical defaults for the
 *  overlay in use. When `overlay` is null / undefined or unknown,
 *  returns white-with-grey-floor (the safe fallback that the LLM
 *  occasionally produces when it skips the overlay field).
 *
 *  Exported for testing. */
export function resolveWorldPalette(
  overlay: VideoShot['zennWorldOverlay'],
  world: VideoConfig['zennV1World'],
): { sky_color_hex: string; ground_color_hex: string; wall_color_hex: string } {
  const key =
    overlay && overlay in WORLD_PALETTE_DEFAULTS
      ? (overlay as keyof typeof WORLD_PALETTE_DEFAULTS)
      : 'sky_only';
  const defaults = WORLD_PALETTE_DEFAULTS[key];
  return {
    sky_color_hex: world?.sky_color_hex ?? defaults.sky_color_hex,
    ground_color_hex: world?.ground_color_hex ?? defaults.ground_color_hex,
    wall_color_hex: world?.wall_color_hex ?? defaults.wall_color_hex,
  };
}

/** Describe the world background as a renderer-ready CSS layout. The
 *  Mode B compositor reads this once per shot and maps each band to
 *  an absolute-positioned div.
 *
 *  Layout semantics:
 *    - `sky_only` and `underwater`: single full-frame fill (gradient
 *      for underwater, solid for sky_only).
 *    - `sky_ground` and `room`: two stacked horizontal bands meeting
 *      at the 50 % horizon line — the reference frames in
 *      `refs/zenn/_analysis/hires/` (ancient_day_240s, calhoun_35s)
 *      all sit on a horizon roughly at the canvas midpoint.
 *    - `null` / unknown: single white fill (defense in depth — the
 *      partition above already covers `null` via `sky_only`).
 *
 *  `topHeightPct` is the percentage of the canvas height the TOP band
 *  occupies; `bottomHeightPct` is the rest. Both sum to 100. The
 *  Mode B renderer uses these directly as CSS `height:` percentages.
 *
 *  Exported for testing. */
export function worldBandLayout(
  overlay: VideoShot['zennWorldOverlay'],
  palette: { sky_color_hex: string; ground_color_hex: string; wall_color_hex: string },
):
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; topColor: string; bottomColor: string }
  | { kind: 'bands'; topColor: string; bottomColor: string; topHeightPct: number; bottomHeightPct: number } {
  if (overlay === 'underwater') {
    return {
      kind: 'gradient',
      topColor: palette.sky_color_hex,
      bottomColor: palette.ground_color_hex,
    };
  }
  if (overlay === 'sky_ground') {
    return {
      kind: 'bands',
      topColor: palette.sky_color_hex,
      bottomColor: palette.ground_color_hex,
      topHeightPct: 50,
      bottomHeightPct: 50,
    };
  }
  if (overlay === 'room') {
    return {
      kind: 'bands',
      topColor: palette.wall_color_hex,
      bottomColor: palette.ground_color_hex,
      topHeightPct: 50,
      bottomHeightPct: 50,
    };
  }
  // 'sky_only', null, undefined, or unknown — single fill.
  return { kind: 'solid', color: palette.sky_color_hex };
}

/** Resolve the character image URL for a Mode B shot. Looks up the
 *  bank entry by `characterId`, prefers a pose-specific sibling if
 *  one is registered under `zennPose`, falls back to the canonical
 *  base. Returns undefined when the character has no bank entry
 *  (the renderer renders no character layer in that case — Mode B
 *  without a character is a pure backdrop shot).
 *
 *  Lookup is normalized via `normalizeZennCharacterId` so case-
 *  variant slugs ("Knight" vs "knight") resolve to the same bank
 *  entry. The pipeline writes bank entries under the normalized
 *  key (QA fix 2026-06-10), so this side does the matching
 *  transform on read.
 *
 *  Exported for testing. */
export function resolveCharacterUrl(
  bank: VideoConfig['zennV1CharacterBank'],
  characterId: string | undefined,
  pose: string | undefined,
): string | undefined {
  if (!characterId || !bank) return undefined;
  const normalized = normalizeZennCharacterId(characterId);
  if (!normalized) return undefined;
  // Try the normalized key first (the post-QA-fix write contract).
  // Fall back to the raw key for back-compat with bank entries
  // written by earlier code that keyed by canonicalId.
  const entry = bank[normalized] ?? bank[characterId];
  if (!entry) return undefined;
  if (pose && entry.poses?.[pose]) return entry.poses[pose];
  return entry.base_url || undefined;
}

// ─── component ──────────────────────────────────────────────────────

interface ZennSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  shotIndex?: number;
  suppressLowerThird?: boolean;
  fadeEnabled?: boolean;
  lowerThirdVariant?: LowerThirdVariant;
  /** Resolved zenn_v1 settings forwarded by the SceneRouter. When
   *  undefined (a non-zenn_v1 caller reaching this scene by accident),
   *  the renderer falls back to the same canonical defaults the
   *  resolver applies. PR 3 reads no settings fields directly — they
   *  matter to PR 4 (canvas_reveal layer cap) and PR 6 (label color).
   *  Threaded now so future PRs don't need to revisit the prop API. */
  zennSettings?: Required<ZennV1Settings>;
  /** Per-doc character bank — slug → canonical PNG + pose siblings.
   *  Threaded from `VideoConfig.zennV1CharacterBank`. Undefined ⇒ no
   *  character layer rendered (the shot is a pure backdrop). */
  characterBank?: VideoConfig['zennV1CharacterBank'];
  /** Per-doc world definition — hex palette + recurring props.
   *  Threaded from `VideoConfig.zennV1World`. Undefined ⇒ canonical
   *  defaults via `resolveWorldPalette`. */
  world?: VideoConfig['zennV1World'];
}

export const ZennScene: React.FC<ZennSceneProps> = ({
  shot,
  durationInFrames,
  fadeEnabled = true,
  characterBank,
  world,
  zennSettings,
}) => {
  const isSceneMode = shot.zennMode === 'scene';
  const palette = resolveWorldPalette(shot.zennWorldOverlay, world);
  const layout = worldBandLayout(shot.zennWorldOverlay, palette);
  const characterUrl = resolveCharacterUrl(characterBank, shot.zennCharacterId, shot.zennPose);
  const revealLayers = shot.zennCanvasRevealLayers ?? [];

  return (
    <AbsoluteFill style={{ backgroundColor: '#FFFFFF', overflow: 'hidden' }}>
      {/* Layer 1: backdrop. Mode B paints CSS color bands from the
          doc-level world palette. Mode A renders the AI-generated
          base image (which already includes the stick-figure-on-
          white canvas + grey ground baseline baked by the PR 1 ai
          image suffix). */}
      {isSceneMode ? (
        <WorldBackground layout={layout} />
      ) : shot.imageUrl ? (
        <AbsoluteFill>
          <Img
            src={shot.imageUrl}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ backgroundColor: '#FFFFFF' }} />
      )}

      {/* Layer 2: static props (PR 5 — stub) */}

      {/* Layer 3: character pose (Mode B only — Mode A's character is
          already baked into the AI image). */}
      {isSceneMode && characterUrl ? (
        <CharacterLayer url={characterUrl} overlay={shot.zennWorldOverlay} />
      ) : null}

      {/* Layer 4: canvas_reveal sibling layers. Each layer mounts in
          its own <Sequence> at `reveal_at_ms` and fades in over
          `fade_in_ms` (or appears instantly when fade_in_ms === 0,
          producing canvas_layer_add semantics). Layers pending
          pipeline generation (no image_url) are skipped silently. */}
      <CanvasRevealLayers
        layers={revealLayers}
        shotDurationFrames={durationInFrames}
      />

      {/* Layer 5: red hand-lettered label overlay. Replaces the
          default doodle-yellow LowerThird for zenn_v1 rows. Honors
          settings (label color, highlighter on/off, highlighter
          color) and parses [hl]word[/hl] markers from the row's
          on_screen_text into highlighted spans. Skipped when the
          row has no on_screen_text. See plan §4.2 typography
          and §8 settings. */}
      {shot.onScreenText ? (
        <ZennLabelOverlay
          text={shot.onScreenText}
          labelColorHex={zennSettings?.label_color_hex ?? '#D32F2F'}
          highlighterColorHex={zennSettings?.highlighter_color_hex ?? '#FFE840'}
          highlighterEnabled={zennSettings?.highlighter_enabled ?? true}
        />
      ) : null}

      {/* Layer 6: scene transition (cross-fade across shot boundaries).
          Matches BRollScene / MotionScene exactly so Mode B shots
          inherit the same shot-edge feel as the rest of the project. */}
      <SceneTransition
        fadeIn={fadeEnabled}
        fadeOut={fadeEnabled}
        totalFrames={durationInFrames}
        durationInFrames={8}
      />
    </AbsoluteFill>
  );
};

// ─── internal layer components ──────────────────────────────────────

const WorldBackground: React.FC<{ layout: ReturnType<typeof worldBandLayout> }> = ({
  layout,
}) => {
  if (layout.kind === 'solid') {
    return <AbsoluteFill style={{ backgroundColor: layout.color }} />;
  }
  if (layout.kind === 'gradient') {
    return (
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, ${layout.topColor} 0%, ${layout.bottomColor} 100%)`,
        }}
      />
    );
  }
  // bands
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: `${layout.topHeightPct}%`,
          backgroundColor: layout.topColor,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: `${layout.bottomHeightPct}%`,
          backgroundColor: layout.bottomColor,
        }}
      />
    </AbsoluteFill>
  );
};

const CanvasRevealLayers: React.FC<{
  layers: CanvasRevealLayerInput[];
  shotDurationFrames: number;
}> = ({ layers, shotDurationFrames }) => {
  const { fps, durationInFrames } = useVideoConfig();
  // Convert the shot's duration to ms once so the per-layer resolver
  // can clamp every value into the shot window. useVideoConfig is the
  // canonical source for fps inside a Remotion scene; passing the
  // shot's durationInFrames in lets the resolver clamp without
  // calling back into the composition.
  const shotDurationMs = (shotDurationFrames / fps) * 1000;
  // useVideoConfig().durationInFrames is the composition's total
  // duration (every shot summed). Each <Sequence> inside this scene
  // is already scoped to the shot's window by the parent SceneRouter,
  // so we just need to clamp our layer windows against THIS shot's
  // duration. Logging the composition total here would be misleading.
  void durationInFrames;

  return (
    <AbsoluteFill>
      {layers.map((layer, i) => {
        if (!isRevealLayerRenderable(layer)) return null;
        const { fromFrame, durationFrames, fadeFrames } = resolveRevealWindow(
          layer,
          shotDurationMs,
          fps,
        );
        if (durationFrames <= 0) return null;
        return (
          <Sequence
            key={`zenn-reveal-${i}`}
            from={fromFrame}
            durationInFrames={durationFrames}
            name={`zenn-canvas-reveal-${i}`}
          >
            <RevealLayerImg url={layer.image_url} fadeFrames={fadeFrames} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const RevealLayerImg: React.FC<{ url: string; fadeFrames: number }> = ({
  url,
  fadeFrames,
}) => {
  const frame = useCurrentFrame();
  // Linear ramp 0 → 1 over fadeFrames, then held at 1. fadeFrames === 0
  // produces an instant appear (canvas_layer_add semantics in plan §4.2).
  // We use `interpolate` directly here rather than calling
  // `revealLayerOpacityAt(frame, fadeFrames)` so Remotion's serialization
  // sees a frame-aware computation; the pure helper still exists for
  // unit testing the math separately.
  const opacity =
    fadeFrames <= 0
      ? 1
      : interpolate(frame, [0, Math.max(1, fadeFrames)], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={url}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </AbsoluteFill>
  );
};

const CharacterLayer: React.FC<{
  url: string;
  overlay: VideoShot['zennWorldOverlay'];
}> = ({ url, overlay }) => {
  // Position the character so its feet land near the horizon line for
  // overlays that have one (sky_ground / room sit at 50 %). For
  // sky_only / underwater we bottom-anchor with a small breathing
  // margin so the character does not crash into the frame edge.
  const bottomPct = overlay === 'sky_ground' || overlay === 'room' ? 0 : 5;
  const heightPct = overlay === 'sky_ground' || overlay === 'room' ? 55 : 75;
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          bottom: `${bottomPct}%`,
          left: '50%',
          height: `${heightPct}%`,
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
        }}
      >
        <Img
          src={url}
          style={{
            height: '100%',
            width: 'auto',
            objectFit: 'contain',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

// ─── Red hand-lettered label overlay ────────────────────────────────
//
// Replaces the default LowerThird for zenn_v1 rows. Renders the
// row's `on_screen_text` as bold red hand-lettered text at the top
// of the frame, with optional yellow highlighter spans where the
// LLM emits `[hl]word[/hl]` markers.
//
// Visual contract derived from the reference frames at
// `refs/zenn/_analysis/hires/` — labels are large, top-center, with
// the yellow highlighter painting a translucent stripe BEHIND the
// word. Slight rotation gives the hand-lettered feel without
// requiring a custom font file.

const ZennLabelOverlay: React.FC<{
  text: string;
  labelColorHex: string;
  highlighterColorHex: string;
  highlighterEnabled: boolean;
}> = ({ text, labelColorHex, highlighterColorHex, highlighterEnabled }) => {
  const segments = parseZennLabel(text);
  const highlighterBg = highlighterEnabled ? highlighterRgba(highlighterColorHex) : 'transparent';
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '6%',
          left: '10%',
          right: '10%',
          textAlign: 'center',
          fontFamily: '"Caveat", "Patrick Hand", "Comic Sans MS", system-ui, sans-serif',
          fontSize: 96,
          fontWeight: 900,
          color: labelColorHex,
          lineHeight: 1.0,
          letterSpacing: 1,
          transform: 'rotate(-1deg)',
          textShadow: '0 0 0 transparent',
        }}
      >
        {segments.map((segment, i) =>
          segment.highlighted ? (
            <span
              key={`zenn-label-seg-${i}`}
              style={{
                background: highlighterBg,
                padding: '0 0.15em',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {segment.text}
            </span>
          ) : (
            <span key={`zenn-label-seg-${i}`}>{segment.text}</span>
          ),
        )}
      </div>
    </AbsoluteFill>
  );
};
