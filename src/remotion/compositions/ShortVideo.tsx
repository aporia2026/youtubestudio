import React from 'react';
import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ShortVideoConfig } from '@/lib/shorts-render-types';

/**
 * Vertical 1080×1920 Short composition.
 *
 * Layout (intentionally minimal — the shorts algorithm rewards clarity,
 * not motion graphics flexing):
 *   - Full-bleed gradient/colour background
 *   - Title chip near the top, 90% opacity, fades out after 1.5s
 *   - Massive captions filling the middle 60% of the screen, one
 *     chunk at a time, scaled by length (longer chunks shrink to fit)
 *   - Channel-name pill at the bottom (optional)
 *   - Voiceover audio plays the whole way through
 *
 * No images, B-roll, or motion graphics in v1 — this is the floor of
 * "publishable Short". Future iterations can add: animated background,
 * waveform visualisation, per-word highlight, B-roll overlays from
 * the broll_clips table.
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
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsedMs = (frame / fps) * 1000;

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
      {activeCaption && <CaptionChunk caption={activeCaption} elapsedMs={elapsedMs} accent={config.accent_color ?? '#fff'} />}

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
}: {
  caption: { start_ms: number; end_ms: number; text: string };
  elapsedMs: number;
  accent: string;
}) {
  // Fade transitions — 80ms in, 80ms out — feels snappy but not jarring.
  const inDur = 80;
  const outDur = 80;
  const sinceStart = elapsedMs - caption.start_ms;
  const untilEnd = caption.end_ms - elapsedMs;
  const fadeIn = Math.min(1, Math.max(0, sinceStart / inDur));
  const fadeOut = Math.min(1, Math.max(0, untilEnd / outDur));
  const opacity = Math.min(fadeIn, fadeOut);

  // Scale font down for longer chunks so they always fit. Empirical:
  // 5 words = 96px is comfortable; 8 words = 72px.
  const wordCount = caption.text.split(/\s+/).filter(Boolean).length;
  const fontSize = wordCount <= 4 ? 110 : wordCount <= 6 ? 92 : wordCount <= 8 ? 76 : 64;

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 80px' }}>
      <div
        style={{
          fontSize,
          fontWeight: 800,
          textAlign: 'center',
          letterSpacing: -1.5,
          lineHeight: 1.05,
          opacity,
          textShadow: '0 6px 30px rgba(0,0,0,0.55)',
          // Accent the LAST word — gives the eye a focal point on the
          // chunk's payoff.
          WebkitTextStroke: '0px',
        }}
      >
        {caption.text.split(/\s+/).map((word, i, arr) => (
          <React.Fragment key={i}>
            <span style={i === arr.length - 1 ? { color: accent } : undefined}>{word}</span>
            {i < arr.length - 1 ? ' ' : ''}
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
}
