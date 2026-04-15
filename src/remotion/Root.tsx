import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { YouTubeVideo } from './compositions/YouTubeVideo';
import type { YouTubeVideoProps } from './compositions/YouTubeVideo';
import { VideoConfig, DEFAULT_BRAND_KIT } from './types';
import { totalFrames } from './utils';

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

// ─── Register root ─────────────────────────────────────────────────────────────

export const RemotionRoot = () => {
  return (
    // Remotion's Composition requires Props extends Record<string, unknown>.
    // We cast once here — the runtime behaviour is correct; only the static
    // generics constraint is worked around.
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
  );
};

registerRoot(RemotionRoot);
