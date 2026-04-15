import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  useVideoConfig,
} from 'remotion';
import { TitleCardScene } from '../scenes/TitleCardScene';
import { BRollScene } from '../scenes/BRollScene';
import { TextRevealScene } from '../scenes/TextRevealScene';
import { IconScene } from '../scenes/IconScene';
import { ScreenMockupScene } from '../scenes/ScreenMockupScene';
import { OutroScene } from '../scenes/OutroScene';
import { VideoConfig, VideoShot } from '../types';
import { msToFrame } from '../utils';

export interface YouTubeVideoProps {
  config: VideoConfig;
}

/**
 * Main YouTube video composition (16:9, 1920×1080).
 * Routes each VideoShot to the appropriate scene component,
 * overlays voiceover audio, and optionally background music.
 */
export const YouTubeVideo: React.FC<YouTubeVideoProps> = ({ config }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: config.brand.backgroundColor }}>

      {/* Voiceover audio — runs for the full video */}
      {config.voiceoverUrl && (
        <Audio src={config.voiceoverUrl} volume={1} />
      )}

      {/* Background music — ducked under voiceover */}
      {config.musicUrl && (
        <Audio
          src={config.musicUrl}
          volume={config.musicVolume ?? 0.12}
          loop
        />
      )}

      {/* Render each shot as a Sequence */}
      {config.shots.map((shot, i) => {
        const fromFrame = msToFrame(shot.startMs, fps);
        const durationInFrames = Math.max(msToFrame(shot.durationMs, fps), 1);

        return (
          <Sequence
            key={i}
            from={fromFrame}
            durationInFrames={durationInFrames}
            name={`Shot ${i + 1}: ${shot.sceneType}`}
          >
            <SceneRouter
              shot={shot}
              durationInFrames={durationInFrames}
              config={config}
              shotIndex={i}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Scene Router ─────────────────────────────────────────────────────────────

interface SceneRouterProps {
  shot: VideoShot;
  durationInFrames: number;
  config: VideoConfig;
  shotIndex: number;
}

const SceneRouter: React.FC<SceneRouterProps> = ({ shot, durationInFrames, config, shotIndex }) => {
  const props = { shot, durationInFrames, brand: config.brand };

  switch (shot.sceneType) {
    case 'title-card':
      return <TitleCardScene {...props} />;
    case 'text-reveal':
      return <TextRevealScene {...props} />;
    case 'icon-scene':
      return <IconScene {...props} />;
    case 'screen-mockup':
      return <ScreenMockupScene {...props} />;
    case 'outro':
      return <OutroScene {...props} />;
    case 'b-roll':
    case 'split-scene':
    default:
      return <BRollScene {...props} shotIndex={shotIndex} />;
  }
};
