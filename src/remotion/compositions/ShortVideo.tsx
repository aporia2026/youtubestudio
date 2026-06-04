import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { ShortVideoConfig, ShortCaptionChunk } from '@/lib/shorts-render-types';
import {
  resolveDoodleCaptionStyle,
  entryEffectTransform,
  type ResolvedDoodleCaptionStyle,
} from '../doodle-caption-style';
import { findActiveWordIndex } from '@/lib/shorts-caption-words';

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
  caption: ShortCaptionChunk;
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
  const words = caption.words ?? proportionalWordsForRender(caption);
  const wordCount = words.length;
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
        {renderMinimalWords({ words, elapsedMs, cfg, highlightColor, outlineColor })}
      </div>
    </div>
  );
}

/** Word-loop for the Minimal style. Back-compat: when `wordHighlight`
 *  is undefined or 'none', preserves the original Phase 5.5 behavior of
 *  highlighting only the LAST word in `highlightColor`. When set to a
 *  new mode ('color' / 'scale' / 'background' / 'karaoke'), runs the
 *  same per-word active-index logic the Doodle renderer uses. */
function renderMinimalWords({
  words,
  elapsedMs,
  cfg,
  highlightColor,
  outlineColor,
}: {
  words: Array<{ text: string; start_ms: number; end_ms: number }>;
  elapsedMs: number;
  cfg: import('@/lib/shorts-render-types').ShortsCaptionsStyle | undefined;
  highlightColor: string;
  outlineColor: string;
}) {
  const mode = cfg?.wordHighlight ?? 'none';
  // Back-compat path: old behavior was "last word in highlight color".
  // Keep it for `mode === 'none'` so existing rendered Shorts don't
  // visually change.
  if (mode === 'none') {
    return words.map((word, i, arr) => (
      <React.Fragment key={i}>
        <span style={i === arr.length - 1 ? { color: highlightColor } : undefined}>{word.text}</span>
        {i < arr.length - 1 ? ' ' : ''}
      </React.Fragment>
    ));
  }
  const activeIndex = findActiveWordIndex(words, elapsedMs);
  const activeColor = cfg?.activeWordColor ?? highlightColor;
  const spokenColor = cfg?.spokenWordColor ?? 'rgba(255,255,255,0.45)';
  return words.map((word, i) => {
    const isActive = i === activeIndex;
    const isPast = activeIndex !== -1 && i < activeIndex;
    let style: React.CSSProperties | undefined;
    if (mode === 'color') {
      style = isActive ? { color: activeColor } : undefined;
    } else if (mode === 'scale') {
      style = {
        display: 'inline-block',
        transform: isActive ? 'scale(1.15)' : 'scale(1)',
        transformOrigin: 'center bottom',
        transition: 'transform 60ms ease-out',
      };
    } else if (mode === 'background') {
      style = isActive
        ? {
            backgroundColor: activeColor,
            color: outlineColor || '#000',
            padding: '0 8px',
            borderRadius: 8,
          }
        : undefined;
    } else if (mode === 'karaoke') {
      if (isActive) style = { color: activeColor };
      else if (isPast) style = { color: spokenColor };
    }
    return (
      <React.Fragment key={i}>
        <span style={style}>{word.text}</span>
        {i < words.length - 1 ? ' ' : ''}
      </React.Fragment>
    );
  });
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
// The doodle defaults live in `doodle-caption-style.ts` so the resolver
// owns them in one place. The renderer reads the resolved values below.

function DoodleShortVideo({ config }: ShortVideoProps) {
  // Resolve the user's caption-style overrides on top of the doodle
  // defaults. Empty / undefined cfg keeps the original doodle look.
  const captionStyle = resolveDoodleCaptionStyle(config.captions_config?.style);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;

  // Find the active caption chunk for caption rendering.
  const activeIndex = config.captions.findIndex(
    (c) => elapsedMs >= c.start_ms && elapsedMs < c.end_ms,
  );
  const activeCaption = activeIndex >= 0 ? config.captions[activeIndex] : null;

  // Phase 15.17 — each doodle frame becomes its own <Sequence> so the
  // i2v `<OffthreadVideo>` plays from t=0 when its window opens
  // (Sequences re-anchor child time). Frame i starts at the
  // caption[start_index].start_ms and runs until frame (i+1)'s
  // caption.start_ms, or the end of the composition for the last
  // frame. Sorted ascending by caption_chunk_start_index upstream in
  // `buildShortVideoConfig`, so neighbour math is correct as-is.
  const rawFrames = config.doodle_frames ?? [];
  const frameWindows = rawFrames.map((f, i) => {
    const captionForFrame = config.captions[f.caption_chunk_start_index];
    const startMs = captionForFrame?.start_ms ?? 0;
    const nextFrame = rawFrames[i + 1];
    const nextStartMs = nextFrame
      ? config.captions[nextFrame.caption_chunk_start_index]?.start_ms ?? config.duration_ms
      : config.duration_ms;
    const fromFrames = Math.max(0, Math.round((startMs / 1000) * fps));
    const lengthFrames = Math.max(
      1,
      Math.round(((nextStartMs - startMs) / 1000) * fps),
    );
    // Clamp the tail to the actual composition length so the last
    // frame doesn't get a Sequence that extends past durationInFrames.
    const cappedLength = Math.max(1, Math.min(lengthFrames, durationInFrames - fromFrames));
    return { ...f, fromFrames, lengthFrames: cappedLength };
  });

  const titleOpacity = elapsedMs < 1200 ? 1 : Math.max(0, 1 - (elapsedMs - 1200) / 600);

  return (
    <AbsoluteFill style={{ background: '#ffffff', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {config.voiceover_url && <Audio src={config.voiceover_url} />}

      {/* Full-bleed sibling frame layer — one Sequence per frame. */}
      {frameWindows.map((f, i) => (
        <Sequence
          key={`${f.url}-${i}`}
          from={f.fromFrames}
          durationInFrames={f.lengthFrames}
        >
          {f.animation_url ? (
            // OffthreadVideo > Video for Lambda renders: doesn't block
            // the main render thread and handles longer clips without
            // chewing memory. muted because the voiceover is the
            // single audio source — vendor mp4s sometimes ship with
            // ambient hum the model added to "fill" the clip.
            <OffthreadVideo
              src={f.animation_url}
              muted
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : (
            <Img
              src={f.url}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          )}
        </Sequence>
      ))}

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

      {/* Caption band — middle-60% safe zone, defaults to the yellow
          comic-bold doodle look; every field in `captions_config.style`
          overrides its slot via `resolveDoodleCaptionStyle`. */}
      {activeCaption && (
        <DoodleCaptionChunk
          caption={activeCaption}
          elapsedMs={elapsedMs}
          style={captionStyle}
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
  style,
}: {
  caption: ShortCaptionChunk;
  elapsedMs: number;
  style: ResolvedDoodleCaptionStyle;
}) {
  const inDur = 80;
  const outDur = 80;
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / inDur));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / outDur));
  const opacity = Math.min(fadeIn, fadeOut);

  // Build the per-word list. Prefer real word boundaries from the
  // alignment payload (set by `attachWordTimingsToChunks`); fall back
  // to evenly-distributed tokens so the highlight effects still have
  // SOMETHING to track when alignment is missing.
  const words = caption.words ?? proportionalWordsForRender(caption);
  const activeIndex =
    style.wordHighlight === 'none'
      ? -1
      : findActiveWordIndex(words, elapsedMs);

  const wordCount = words.length;
  const autoFontSize = wordCount <= 4 ? 96 : wordCount <= 6 ? 80 : wordCount <= 8 ? 64 : 54;
  const fontSize = Math.round(autoFontSize * style.sizeScale);

  const effect = entryEffectTransform(style.entryEffect, sinceStart);

  const fontFamily = style.fontFamily
    ? `'${style.fontFamily}', 'Inter', system-ui, sans-serif`
    : 'Inter, system-ui, sans-serif';

  return (
    <div
      style={{
        position: 'absolute',
        top: `${style.positionY * 100}%`,
        left: 0,
        right: 0,
        transform: 'translateY(-50%)',
        padding: `0 ${style.paddingX}px`,
        display: 'flex',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize,
          fontWeight: style.fontWeight,
          textAlign: 'center',
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          textTransform: style.textTransform,
          color: style.color,
          transform: `translateY(${effect.translateY}px) scale(${effect.scale})`,
          textShadow: style.shadow === 'none' ? undefined : style.shadow,
          WebkitTextStroke:
            style.outlineWidth > 0 ? `${style.outlineWidth}px ${style.outlineColor}` : undefined,
          paintOrder: style.outlineWidth > 0 ? 'stroke fill' : undefined,
          padding: style.background === 'solid' || style.background === 'blur' ? '10px 24px' : 0,
          borderRadius: style.background !== 'none' ? 16 : 0,
          background:
            style.background === 'solid'
              ? style.backgroundColor
              : style.background === 'blur'
                ? 'rgba(0,0,0,0.35)'
                : 'transparent',
          backdropFilter: style.background === 'blur' ? 'blur(20px)' : undefined,
        }}
      >
        {words.map((word, i) => {
          const wordStyle = wordHighlightStyle(style, i, activeIndex);
          return (
            <React.Fragment key={i}>
              <span style={wordStyle}>{word.text}</span>
              {i < words.length - 1 ? ' ' : ''}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Compute the CSS for one word based on its position relative to the
 *  active word + the chosen highlight strategy. Returns an inline-style
 *  object so React can diff cheaply on each frame. */
function wordHighlightStyle(
  style: ResolvedDoodleCaptionStyle,
  wordIndex: number,
  activeIndex: number,
): React.CSSProperties | undefined {
  if (style.wordHighlight === 'none') return undefined;
  // No active word right now (silent gap, pre-first, post-last). For
  // karaoke we still want past words dimmed + future words at body
  // color; for the other modes there's nothing to do.
  if (activeIndex === -1) {
    if (style.wordHighlight === 'karaoke') {
      // Without an active index we can't tell past from future. Default
      // to body color — the active word will paint over this on the
      // very next frame anyway.
      return undefined;
    }
    return undefined;
  }
  const isActive = wordIndex === activeIndex;
  const isPast = wordIndex < activeIndex;

  if (style.wordHighlight === 'color') {
    return isActive ? { color: style.activeWordColor } : undefined;
  }
  if (style.wordHighlight === 'scale') {
    // Inline-block so transform actually applies. 1.15× pop on the
    // active word; everything else stays at 1.0.
    return {
      display: 'inline-block',
      transform: isActive ? 'scale(1.15)' : 'scale(1)',
      transformOrigin: 'center bottom',
      transition: 'transform 60ms ease-out',
    };
  }
  if (style.wordHighlight === 'background') {
    return isActive
      ? {
          backgroundColor: style.activeWordColor,
          color: style.outlineColor, // contrast against the pill
          padding: '0 8px',
          borderRadius: 8,
        }
      : undefined;
  }
  // karaoke: past = spokenWordColor, active = activeWordColor, future = body
  if (isActive) return { color: style.activeWordColor };
  if (isPast) return { color: style.spokenWordColor };
  return undefined;
}

/** When alignment isn't available the chunk still carries text. Build
 *  proportional word records so the highlight effects have data to
 *  drive. Identical math to `proportionalWordTimings` in
 *  `shorts-caption-words.ts` — duplicated here so the renderer doesn't
 *  pull in the server-only module graph. */
function proportionalWordsForRender(
  caption: ShortCaptionChunk,
): Array<{ text: string; start_ms: number; end_ms: number }> {
  const tokens = caption.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const chunkDurMs = Math.max(1, caption.end_ms - caption.start_ms);
  return tokens.map((text, i) => ({
    text,
    start_ms: Math.round(caption.start_ms + (chunkDurMs * i) / tokens.length),
    end_ms: Math.round(caption.start_ms + (chunkDurMs * (i + 1)) / tokens.length),
  }));
}
