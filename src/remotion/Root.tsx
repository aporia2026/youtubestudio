import React from 'react';
import { Composition, registerRoot } from 'remotion';
import './fonts'; // side-effect: loads Inter via @remotion/google-fonts before first frame
import { YouTubeVideo } from './compositions/YouTubeVideo';
import type { YouTubeVideoProps } from './compositions/YouTubeVideo';
import { ShortVideo } from './compositions/ShortVideo';
import type { ShortVideoProps } from './compositions/ShortVideo';
import { VideoConfig, DEFAULT_BRAND_KIT } from './types';
import { totalFrames } from './utils';
import {
  SHORT_FPS,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  type ShortVideoConfig,
} from '@/lib/shorts-render-types';

// ─── Default demo config (used in Remotion Studio) ────────────────────────────

const DEMO_CONFIG: VideoConfig = {
  fps: 30,
  width: 1920,
  height: 1080,
  brand: DEFAULT_BRAND_KIT,
  showCaptions: true,
  shots: [
    {
      startMs: 0,
      durationMs: 4000,
      sceneType: 'title-card',
      title: 'WannaCry',
      subtitle: 'The ransomware that infected 200,000 computers',
      backgroundColor: '#FFFFFF',
    },
    {
      startMs: 4000,
      durationMs: 5000,
      sceneType: 'icon-scene',
      title: 'WannaCry',
      onScreenText: 'Encrypts your files',
    },
    {
      startMs: 9000,
      durationMs: 5000,
      sceneType: 'b-roll',
      onScreenText: 'Spreads through the network',
    },
    {
      startMs: 14000,
      durationMs: 4000,
      sceneType: 'text-reveal',
      onScreenText: '200,000 computers infected\n150 countries hit\n$4 billion in damages',
    },
    {
      startMs: 18000,
      durationMs: 6000,
      sceneType: 'outro',
      backgroundColor: '#FFFFFF',
    },
  ],
};

// ─── Default Short demo (Remotion Studio fallback) ────────────────────────────

const DEMO_SHORT_CONFIG: ShortVideoConfig = {
  fps: SHORT_FPS,
  width: SHORT_WIDTH,
  height: SHORT_HEIGHT,
  voiceover_url: '',
  duration_ms: 12_000,
  title: 'Demo Short',
  background: 'linear-gradient(180deg, #1a1033 0%, #050510 100%)',
  accent_color: '#a78bfa',
  channel_name: 'YouTubeStudio',
  captions: [
    { start_ms: 0, end_ms: 2200, text: 'The hook lands here.' },
    { start_ms: 2200, end_ms: 6000, text: 'Then a punchy middle.' },
    { start_ms: 6000, end_ms: 10_000, text: 'And the payoff.' },
    { start_ms: 10_000, end_ms: 12_000, text: 'Comment your guess.' },
  ],
};

// ─── Register root ─────────────────────────────────────────────────────────────

export const RemotionRoot = () => {
  return (
    <>
      {/* Remotion's Composition requires Props extends Record<string, unknown>.
          We cast once per composition — runtime behaviour is correct; only
          the static generics constraint is worked around. */}
      <Composition
        id="YouTubeVideo"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={YouTubeVideo as React.ComponentType<any>}
        durationInFrames={totalFrames(DEMO_CONFIG)}
        fps={DEMO_CONFIG.fps}
        width={DEMO_CONFIG.width}
        height={DEMO_CONFIG.height}
        defaultProps={{ config: DEMO_CONFIG }}
        calculateMetadata={async ({ props }) => {
          const cfg = (props as unknown as YouTubeVideoProps).config;
          return {
            durationInFrames: totalFrames(cfg),
            fps: cfg.fps,
            width: cfg.width,
            height: cfg.height,
          };
        }}
      />
      <Composition
        id="ShortVideo"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={ShortVideo as React.ComponentType<any>}
        durationInFrames={Math.ceil((DEMO_SHORT_CONFIG.duration_ms / 1000) * DEMO_SHORT_CONFIG.fps)}
        fps={DEMO_SHORT_CONFIG.fps}
        width={DEMO_SHORT_CONFIG.width}
        height={DEMO_SHORT_CONFIG.height}
        defaultProps={{ config: DEMO_SHORT_CONFIG }}
        calculateMetadata={async ({ props }) => {
          const cfg = (props as unknown as ShortVideoProps).config;
          return {
            durationInFrames: Math.ceil((cfg.duration_ms / 1000) * cfg.fps),
            fps: cfg.fps,
            width: cfg.width,
            height: cfg.height,
          };
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
