'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import { msToFrame, totalFrames } from '@/remotion/utils';
import type { VideoConfig } from '@/remotion/types';
import type { PlayerController } from '@/lib/notes/player-controller';

/**
 * Compute the start frame for a given section index using the
 * VideoConfig's per-shot timing. Shots are produced 1:1 from rows in
 * `productionDocToVideoConfig`, so `shots[i]` corresponds to
 * `doc.rows[i]`. If the index is out of range (config not yet ready),
 * we return null and the player stays at its current position.
 */
function sectionStartFrame(config: VideoConfig, sectionIndex: number): number | null {
  const shot = config.shots[sectionIndex];
  if (!shot) return null;
  return msToFrame(shot.startMs, config.fps);
}

interface StageProps {
  config: VideoConfig;
  activeSection: number;
  /** When true, replaces the player with a placeholder. Used when a
   *  big inline editor (mask brush, region editor, overlay drag) takes
   *  over the stage. Phase 1 always renders the player; takeover lands
   *  in Phase 2. */
  takeover?: React.ReactNode;
  /** Fires once on mount with a stable `PlayerController` the host can
   *  hand to the notes dock (pause + seek + getCurrentFrame). Fires
   *  again with `null` on unmount so the host clears its reference. */
  onControllerReady?: (controller: PlayerController | null) => void;
}

/**
 * The editor's "Stage" pane — the always-visible live preview of the
 * active section. Wraps a Remotion `<Player>` and seeks it to the
 * section's start frame whenever the active section changes. Built-in
 * Remotion controls handle play/pause/scrub.
 *
 * The bottom render-button + stats row from `VideoPlayer` is omitted
 * here on purpose — the editor has its own chrome elsewhere.
 */
export const Stage: React.FC<StageProps> = ({ config, activeSection, takeover, onControllerReady }) => {
  const playerRef = useRef<PlayerRef>(null);
  const frames = useMemo(() => totalFrames(config), [config]);
  const [hasInitialSeek, setHasInitialSeek] = useState(false);

  // Same controller bridge VideoPlayer uses — the dock asks the host for
  // a controller and the host passes it down regardless of which
  // surface owns the player. Stable identity across renders because the
  // closure dereferences playerRef.current lazily.
  useEffect(() => {
    if (!onControllerReady) return;
    const controller: PlayerController = {
      getCurrentFrame: () => playerRef.current?.getCurrentFrame() ?? 0,
      pause: () => playerRef.current?.pause(),
      play: () => playerRef.current?.play(),
      seekToFrame: (f) => playerRef.current?.seekTo(f),
      isPlaying: () => playerRef.current?.isPlaying() ?? false,
    };
    onControllerReady(controller);
    return () => onControllerReady(null);
  }, [onControllerReady]);

  // Keep the latest config in a ref so the seek effect can look up the
  // current section's start frame without listing `config` as a
  // dependency. If `config` were in the dep list, every doc edit (and
  // every parent re-render that produced a new memoized config) would
  // re-fire this effect and call `pause()` + `seekTo()` on the live
  // player — interrupting playback. The user's symptom was "play stops
  // at the end of the selected scene": the boundary crossing was
  // coinciding with a config rebuild, which then paused and re-seeked
  // back to the section start. With the ref, the effect only fires when
  // the user actually changes section.
  //
  // We sync the ref in a `useLayoutEffect` (not during render) so the
  // assignment doesn't happen during React's render phase — and runs
  // before the activeSection `useEffect` below in the same commit,
  // guaranteeing that effect reads the latest config.
  const configRef = useRef(config);
  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    if (!playerRef.current) return;
    const target = sectionStartFrame(configRef.current, activeSection);
    if (target == null) return;
    playerRef.current.pause();
    playerRef.current.seekTo(target);
    setHasInitialSeek(true);
  }, [activeSection]);

  if (takeover) {
    return (
      <div
        className="w-full rounded-xl overflow-hidden border"
        style={{
          aspectRatio: '16/9',
          background: '#0a0a0a',
          borderColor: 'var(--border)',
        }}
      >
        {takeover}
      </div>
    );
  }

  if (frames <= 0 || config.shots.length === 0) {
    return (
      <div
        className="w-full rounded-xl overflow-hidden border flex items-center justify-center"
        style={{
          aspectRatio: '16/9',
          background: '#0a0a0a',
          borderColor: 'var(--border)',
          color: 'var(--text-muted)',
          fontSize: 14,
        }}
      >
        No shots to preview yet.
      </div>
    );
  }

  const initialFrame = hasInitialSeek
    ? undefined
    : Math.min(sectionStartFrame(config, activeSection) ?? 0, Math.max(0, frames - 1));

  return (
    <div
      className="w-full rounded-xl overflow-hidden border shadow-xl"
      style={{ borderColor: 'var(--border)' }}
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
        {...(initialFrame != null ? { initialFrame } : {})}
      />
    </div>
  );
};
