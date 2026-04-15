'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Player, PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import { VideoConfig } from '@/remotion/types';
import { totalFrames } from '@/remotion/utils';

interface VideoPlayerProps {
  config: VideoConfig;
  /** Called when user triggers a render-to-MP4 */
  onRender?: () => void;
  isRendering?: boolean;
  renderProgress?: number; // 0–1
  outputUrl?: string;
  /** Start playback at this frame (skip fade-in transitions at frame 0) */
  initialFrame?: number;
  /** When set to a frame number, seeks the player to that frame */
  seekTargetFrame?: number | null;
  /** Called after seekTargetFrame is consumed so parent can reset it */
  onSeekConsumed?: () => void;
}

/**
 * Interactive video preview using @remotion/player.
 * Shows the full assembled video in-browser with play/pause/scrub controls.
 * No rendering needed — pure browser playback.
 */
export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  config,
  onRender,
  isRendering = false,
  renderProgress = 0,
  outputUrl,
  initialFrame = 8,
  seekTargetFrame,
  onSeekConsumed,
}) => {
  const playerRef = useRef<PlayerRef>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Seek when parent requests it
  useEffect(() => {
    if (seekTargetFrame != null && playerRef.current) {
      playerRef.current.seekTo(seekTargetFrame);
      onSeekConsumed?.();
    }
  }, [seekTargetFrame, onSeekConsumed]);

  const frames = totalFrames(config);

  const handlePlayPause = useCallback(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pause();
    } else {
      playerRef.current.play();
    }
    setIsPlaying(p => !p);
  }, [isPlaying]);

  const handleSeekToStart = useCallback(() => {
    playerRef.current?.seekTo(0);
    setIsPlaying(false);
  }, []);

  if (frames <= 0 || config.shots.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          aspectRatio: '16/9',
          background: '#111',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontSize: 16,
          fontFamily: 'system-ui',
        }}
      >
        No shots to preview yet. Generate a production doc first.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Player */}
      <div
        className="rounded-xl overflow-hidden shadow-2xl border border-white/10"
        style={{ position: 'relative' }}
      >
        <Player
          ref={playerRef}
          component={YouTubeVideo}
          durationInFrames={frames}
          fps={config.fps}
          compositionWidth={config.width}
          compositionHeight={config.height}
          inputProps={{ config }}
          style={{ width: '100%' }}
          controls
          showVolumeControls
          clickToPlay
          doubleClickToFullscreen
          spaceKeyToPlayOrPause
          loop={false}
          acknowledgeRemotionLicense
          initialFrame={Math.min(initialFrame, frames - 1)}
        />
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between gap-3">
        {/* Left: video stats */}
        <div className="text-sm text-gray-400 flex items-center gap-4">
          <span>{config.shots.length} shots</span>
          <span>·</span>
          <span>{Math.round(frames / config.fps)}s</span>
          <span>·</span>
          <span>{config.fps}fps</span>
          <span>·</span>
          <span>{config.width}×{config.height}</span>
        </div>

        {/* Right: render button / output */}
        <div className="flex items-center gap-3">
          {outputUrl && (
            <a
              href={outputUrl}
              download
              className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold transition-colors flex items-center gap-2"
            >
              <DownloadIcon />
              Download MP4
            </a>
          )}

          {onRender && (
            <button
              onClick={onRender}
              disabled={isRendering}
              className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center gap-2"
            >
              {isRendering ? (
                <>
                  <SpinnerIcon />
                  Rendering {Math.round(renderProgress * 100)}%
                </>
              ) : (
                <>
                  <RenderIcon />
                  Render to MP4
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Render progress bar */}
      {isRendering && (
        <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-red-500 transition-all duration-300 ease-out"
            style={{ width: `${renderProgress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
};

// ─── Icons ────────────────────────────────────────────────────────────────────

const RenderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const SpinnerIcon = () => (
  <svg
    width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5"
    style={{ animation: 'spin 1s linear infinite' }}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);
