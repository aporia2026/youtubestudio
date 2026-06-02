import React from 'react';
import { AbsoluteFill, Audio, Img, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ShortVideoConfig } from '@/lib/shorts-render-types';

/**
 * Vertical 1080×1920 Short composition.
 *
 * Style dispatch (Phase 15.3):
 *   - 'minimal_gradient_v1' (default) — gradient + caption-only floor.
 *   - 'doodle_explainer_2_short'     — full-bleed Doodle scene with
 *     sibling-frame variants timed to caption chunks; captions overlay
 *     in the middle-60% safe zone with yellow comic-bold styling that
 *     matches the doodle reference videos.
 *   - 'paint_explainer_v1_short'     — Phase 15.4 placeholder; falls
 *     through to minimal.
 *
 * The composition is driven by the per-caption `start_ms` / `end_ms`
 * timestamps the orchestrator computes. We DON'T compute caption
 * timing here — keep the composition pure-display so it's
 * deterministic across renders.
 */
export interface ShortVideoProps {
  config: ShortVideoConfig;
}

export function ShortVideo({ config }: ShortVideoProps) {
  const styleId = config.style_id ?? 'minimal_gradient_v1';
  // Doodle + Paint share the sibling-frame renderer — the data shape
  // (base + variants timed to chunk indices) is identical, only the
  // source images differ. Phase 15.4 reuses the Phase 15.3 path
  // without a render-time split; Phase 15.4.B (full motion-component
  // port) will introduce a separate <PaintShortVideo> when it lands.
  if (
    (styleId === 'doodle_explainer_2_short' || styleId === 'paint_explainer_v1_short')
    && config.doodle_frames
    && config.doodle_frames.length > 0
  ) {
    return <DoodleShortVideo config={config} />;
  }
  return <MinimalShortVideo config={config} />;
}

function MinimalShortVideo({ config }: ShortVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;
  const captionStyle = config.captions_config?.style;

  const activeCaption = config.captions.find(
    (c) => elapsedMs >= c.start_ms && elapsedMs < c.end_ms,
  );

  // Title fades out after 1.5s — a Short's hook lives in the FIRST
  // caption, not the title chip, so we don't want it competing.
  const titleOpacity = elapsedMs < 1200 ? 1 : Math.max(0, 1 - (elapsedMs - 1200) / 600);

  return (
    <AbsoluteFill style={{ background: config.background, color: '#fff', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {config.voiceover_url && <Audio src={config.voiceover_url} />}

      {/* Title chip (top) */}
      {config.title && titleOpacity > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 120,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            opacity: titleOpacity,
          }}
        >
          <div
            style={{
              fontSize: 44,
              fontWeight: 700,
              padding: '14px 32px',
              borderRadius: 28,
              background: 'rgba(255,255,255,0.10)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.18)',
              letterSpacing: -0.6,
              maxWidth: 900,
              textAlign: 'center',
              lineHeight: 1.1,
            }}
          >
            {config.title}
          </div>
        </div>
      )}

      {/* Active caption — center, massive, fade-in by 80ms / fade-out by 80ms */}
      {activeCaption && (
        <CaptionChunk
          caption={activeCaption}
          elapsedMs={elapsedMs}
          accent={config.accent_color ?? '#fff'}
          style={captionStyle}
        />
      )}

      {/* Channel pill (bottom) */}
      {config.channel_name && (
        <div
          style={{
            position: 'absolute',
            bottom: 100,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              padding: '10px 24px',
              borderRadius: 100,
              background: 'rgba(0,0,0,0.45)',
              border: '1px solid rgba(255,255,255,0.15)',
              letterSpacing: 0.5,
            }}
          >
            @ {config.channel_name}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

function CaptionChunk({
  caption,
  elapsedMs,
  accent,
  style: cfg,
}: {
  caption: { start_ms: number; end_ms: number; text: string };
  elapsedMs: number;
  accent: string;
  /** Phase 15.11 — optional caption style overrides. When undefined the
   *  renderer keeps the original Phase 5.5 Minimal defaults so existing
   *  rendered Shorts stay byte-stable. */
  style?: import('@/lib/shorts-render-types').ShortsCaptionsStyle;
}) {
  const inDur = 80;
  const outDur = 80;
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / inDur));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / outDur));
  const baseOpacity = Math.min(fadeIn, fadeOut);

  // Scale font down for longer chunks so they always fit. Empirical:
  // 5 words = 96px is comfortable; 8 words = 72px.
  const wordCount = caption.text.split(/\s+/).filter(Boolean).length;
  const autoFontSize = wordCount <= 4 ? 110 : wordCount <= 6 ? 92 : wordCount <= 8 ? 76 : 64;
  const sizeScale = typeof cfg?.sizeScale === 'number' && cfg.sizeScale > 0 ? cfg.sizeScale : 1;
  const fontSize = Math.round(autoFontSize * sizeScale);

  // Entry effect (Phase 15.11). 'fade' is the Phase-5.5 default.
  const entryEffect = cfg?.entryEffect ?? 'fade';
  let opacity = baseOpacity;
  let scale = 1;
  let translateY = 0;
  if (entryEffect === 'pop') {
    // Pop-in: scale 0.6 → 1.0 over the first 140ms.
    const t = Math.max(0, Math.min(1, sinceStart / 140));
    scale = 0.6 + 0.4 * t;
  } else if (entryEffect === 'slide-up') {
    // Slide from 40px below to position over the first 160ms.
    const t = Math.max(0, Math.min(1, sinceStart / 160));
    translateY = (1 - t) * 40;
  } else if (entryEffect === 'none') {
    opacity = 1; // hard cut
  }

  // Position — vertical band placement. 0.5 = center.
  const positionY = typeof cfg?.positionY === 'number'
    ? Math.max(0, Math.min(1, cfg.positionY))
    : 0.5;
  const paddingX = typeof cfg?.paddingX === 'number' ? cfg.paddingX : 80;

  const fontFamily = cfg?.fontFamily
    ? `'${cfg.fontFamily}', 'Inter', system-ui, sans-serif`
    : 'Inter, system-ui, sans-serif';
  const fontWeight = cfg?.fontWeight ?? 800;
  const color = cfg?.color ?? '#fff';
  const highlightColor = cfg?.highlightColor ?? accent;
  const outlineColor = cfg?.outlineColor ?? 'transparent';
  const outlineWidth = cfg?.outlineWidth ?? 0;
  const shadow = cfg?.shadow ?? '0 6px 30px rgba(0,0,0,0.55)';
  const textTransform = cfg?.textTransform ?? 'none';
  const letterSpacing = typeof cfg?.letterSpacing === 'number' ? cfg.letterSpacing : -1.5;
  const lineHeight = typeof cfg?.lineHeight === 'number' ? cfg.lineHeight : 1.05;
  const background = cfg?.background ?? 'none';
  const backgroundColor = cfg?.backgroundColor ?? 'rgba(0,0,0,0.6)';

  // Position container — `top: ${positionY*100}%` then translate the
  // inner box up by 50% so the band is CENTRED on positionY.
  return (
    <div
      style={{
        position: 'absolute',
        top: `${positionY * 100}%`,
        left: 0,
        right: 0,
        transform: 'translateY(-50%)',
        padding: `0 ${paddingX}px`,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize,
          fontWeight,
          textAlign: 'center',
          letterSpacing,
          lineHeight,
          textTransform,
          opacity,
          color,
          transform: `translateY(${translateY}px) scale(${scale})`,
          textShadow: shadow,
          WebkitTextStroke: outlineWidth > 0 ? `${outlineWidth}px ${outlineColor}` : '0px',
          paintOrder: outlineWidth > 0 ? 'stroke fill' : undefined,
          padding: background === 'solid' || background === 'blur' ? '10px 24px' : 0,
          borderRadius: background !== 'none' ? 16 : 0,
          background: background === 'solid'
            ? backgroundColor
            : background === 'blur'
              ? 'rgba(0,0,0,0.35)'
              : 'transparent',
          backdropFilter: background === 'blur' ? 'blur(20px)' : undefined,
        }}
      >
        {caption.text.split(/\s+/).map((word, i, arr) => (
          <React.Fragment key={i}>
            <span style={i === arr.length - 1 ? { color: highlightColor } : undefined}>{word}</span>
            {i < arr.length - 1 ? ' ' : ''}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Doodle Explainer 2 vertical — Phase 15.3
// ---------------------------------------------------------------------------
//
// Renders the user's selected Doodle vertical style. Layout:
//
//   - Full-bleed sibling-frame image (object-fit: cover at 1080×1920).
//   - The frame swaps to the next variant at each variant's
//     caption_chunk_start_index. Between swaps the frame is STATIC —
//     all "animation" comes from frame swaps (per the user's memory:
//     "near-static = Atlas Edit variants, NEVER Remotion motion").
//   - Title chip across the top (white pill, doodle-friendly) fades out
//     after 1.5s — same beat as the minimal style.
//   - Captions overlay in the MIDDLE 60% safe zone (Y = 576..1344).
//   - Caption styling matches the doodle reference: YELLOW comic-bold
//     fill, thick black wobbly outline, no shadow, no gradient.
//
// The middle-60% safe zone is non-negotiable — the top 10% of a Short
// is covered by YouTube's channel handle / settings chevron and the
// bottom 10% by the Like/Dislike/Comment column on most clients. Text
// outside the safe zone gets visually clipped.

const DOODLE_TITLE_TOP_PX = 96;
const DOODLE_CAPTION_BAND_TOP_RATIO = 0.55; // 55% from top = lower-middle band
const DOODLE_CAPTION_PADDING_X_PX = 64;

function DoodleShortVideo({ config }: ShortVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;

  // Find the active caption chunk for caption rendering.
  const activeIndex = config.captions.findIndex(
    (c) => elapsedMs >= c.start_ms && elapsedMs < c.end_ms,
  );
  const activeCaption = activeIndex >= 0 ? config.captions[activeIndex] : null;

  // Pick the most recent doodle frame whose caption_chunk_start_index
  // is <= the active chunk index. Falls back to the first frame for
  // the very-early window before any variant kicks in.
  const frames = config.doodle_frames ?? [];
  let frameUrl = frames[0]?.url ?? '';
  for (const f of frames) {
    if (activeIndex >= 0 && f.caption_chunk_start_index <= activeIndex) {
      frameUrl = f.url;
    }
  }

  const titleOpacity = elapsedMs < 1200 ? 1 : Math.max(0, 1 - (elapsedMs - 1200) / 600);

  return (
    <AbsoluteFill style={{ background: '#ffffff', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {config.voiceover_url && <Audio src={config.voiceover_url} />}

      {/* Full-bleed sibling frame */}
      {frameUrl && (
        <Img
          src={frameUrl}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}

      {/* Title chip at the top safe-zone margin */}
      {config.title && titleOpacity > 0 && (
        <div
          style={{
            position: 'absolute',
            top: DOODLE_TITLE_TOP_PX,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            opacity: titleOpacity,
          }}
        >
          <div
            style={{
              fontSize: 40,
              fontWeight: 800,
              padding: '12px 28px',
              borderRadius: 24,
              background: 'rgba(255,255,255,0.92)',
              color: '#0f172a',
              border: '3px solid #0f172a',
              letterSpacing: -0.5,
              maxWidth: 900,
              textAlign: 'center',
              lineHeight: 1.1,
            }}
          >
            {config.title}
          </div>
        </div>
      )}

      {/* Caption band — middle-60% safe zone, yellow comic-bold styling */}
      {activeCaption && (
        <DoodleCaptionChunk
          caption={activeCaption}
          elapsedMs={elapsedMs}
        />
      )}

      {/* Channel pill at the bottom safe-zone margin */}
      {config.channel_name && (
        <div
          style={{
            position: 'absolute',
            bottom: 96,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              padding: '8px 22px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.92)',
              color: '#0f172a',
              border: '2px solid #0f172a',
              letterSpacing: 0.4,
            }}
          >
            @ {config.channel_name}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

function DoodleCaptionChunk({
  caption,
  elapsedMs,
}: {
  caption: { start_ms: number; end_ms: number; text: string };
  elapsedMs: number;
}) {
  const inDur = 80;
  const outDur = 80;
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / inDur));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / outDur));
  const opacity = Math.min(fadeIn, fadeOut);

  const wordCount = caption.text.split(/\s+/).filter(Boolean).length;
  // Slightly smaller than minimal to leave breathing room for the
  // illustration behind it.
  const fontSize = wordCount <= 4 ? 96 : wordCount <= 6 ? 80 : wordCount <= 8 ? 64 : 54;

  return (
    <div
      style={{
        position: 'absolute',
        top: `${DOODLE_CAPTION_BAND_TOP_RATIO * 100}%`,
        left: 0,
        right: 0,
        padding: `0 ${DOODLE_CAPTION_PADDING_X_PX}px`,
        display: 'flex',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          fontSize,
          fontWeight: 900,
          textAlign: 'center',
          letterSpacing: -0.5,
          lineHeight: 1.05,
          color: '#facc15',                            // doodle yellow
          // Thick black outline matches the doodle reference's hand-drawn
          // comic bold typography — see production-doc-styles.ts
          // BAKED TYPOGRAPHY block.
          WebkitTextStroke: '6px #0f172a',
          paintOrder: 'stroke fill',
          textTransform: 'uppercase',
        }}
      >
        {caption.text}
      </div>
    </div>
  );
}
