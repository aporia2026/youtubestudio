'use client';

/**
 * Transport bar — Phase 2 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Sits directly under the Remotion preview in the editor's `preview`
 * slot. Owns the play / pause / skip / playback-rate / time-readout /
 * fullscreen controls, modeled after CapCut Web's transport row.
 *
 * The component takes a `PlayerRef` from `@remotion/player` (the same
 * ref the editor already manages for frame-update events) and drives
 * playback through its imperative API:
 *
 *   - `play()` / `pause()` for the play button.
 *   - `seekTo(frame)` for skip-prev / skip-next / scrub.
 *   - `getPlaybackRate()` / `setPlaybackRate(rate)` for the rate
 *     dropdown.
 *   - `requestFullscreen()` for the fullscreen toggle.
 *
 * Skip-prev / skip-next jump to the previous / next shot boundary
 * (a more useful unit for shot-graph editing than ±10 s). The
 * boundary list is computed from `shotStartTimesMs`.
 *
 * The component is purely controlled by `playheadMs` from the
 * store, so play/pause state and time readout always reflect the
 * canonical timeline position even when seeks come from other
 * sources (timeline click, keyboard, external commands).
 */

import { useCallback, useEffect, useState } from 'react';
// PlaybackRate is now controlled by the parent (it's a `<Player>` prop,
// not a `PlayerRef` method). Re-export for parents that want the type.
import type { PlayerRef } from '@remotion/player';
import {
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';

interface TransportBarProps {
  playerRef: React.RefObject<PlayerRef | null>;
  playheadMs: number;
  totalDurationMs: number;
  /** Cumulative shot start times in ms. Used by skip-prev /
   *  skip-next to snap to the nearest shot boundary. Passed in
   *  rather than computed here because the editor already memoizes
   *  this on `state.doc`. */
  shotStartTimesMs: number[];
  /** Seek callback. We seek via the player ref AND notify the store
   *  so the playhead state updates in lockstep — without this, a
   *  skip-prev that lands on a frame the player hasn't dispatched
   *  yet would leave the store one tick behind. */
  onSeek: (ms: number) => void;
  /** FPS of the composition, needed to translate ms → frames. */
  fps: number;
  /** Current playback rate, owned by the parent (it's a prop on
   *  `<Player>`, not a setter on `PlayerRef`). */
  playbackRate: PlaybackRate;
  onPlaybackRateChange: (rate: PlaybackRate) => void;
}

export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function TransportBar({
  playerRef,
  playheadMs,
  totalDurationMs,
  shotStartTimesMs,
  onSeek,
  fps,
  playbackRate,
  onPlaybackRateChange,
}: TransportBarProps): React.ReactElement {
  const [playing, setPlaying] = useState(false);

  // Subscribe to play/pause events from the player so our button
  // reflects state even when the user clicks Remotion's built-in
  // controls. `@remotion/player` emits `play` and `pause` events
  // synchronously when the playback state changes.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    return () => {
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
    };
  }, [playerRef]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playing) {
      player.pause();
      console.info('[editor transport] pause', { playheadMs });
    } else {
      player.play();
      console.info('[editor transport] play', { playheadMs });
    }
  }, [playerRef, playing, playheadMs]);

  const skipPrev = useCallback(() => {
    // Jump to the LAST shot boundary that's strictly before the
    // current playhead. If we're inside a shot (not exactly on a
    // boundary), that lands at the start of THIS shot — first
    // skip-prev rewinds to the shot start, second snaps back one.
    // Mirrors how CapCut's "previous frame" / "previous cut" key
    // behaves.
    const target = [...shotStartTimesMs]
      .reverse()
      .find((ms) => ms < playheadMs - 16); // 16ms slop = ~half a frame
    const seekMs = target ?? 0;
    console.info('[editor transport] skip-prev', { from: playheadMs, to: seekMs });
    onSeek(seekMs);
    playerRef.current?.seekTo(Math.round((seekMs / 1000) * fps));
  }, [shotStartTimesMs, playheadMs, onSeek, playerRef, fps]);

  const skipNext = useCallback(() => {
    const target = shotStartTimesMs.find((ms) => ms > playheadMs + 16);
    const seekMs = target ?? totalDurationMs;
    console.info('[editor transport] skip-next', { from: playheadMs, to: seekMs });
    onSeek(seekMs);
    playerRef.current?.seekTo(Math.round((seekMs / 1000) * fps));
  }, [shotStartTimesMs, playheadMs, totalDurationMs, onSeek, playerRef, fps]);

  const changeRate = useCallback(
    (next: PlaybackRate) => {
      onPlaybackRateChange(next);
      console.info('[editor transport] rate', { rate: next });
    },
    [onPlaybackRateChange],
  );

  const requestFullscreen = useCallback(() => {
    try {
      playerRef.current?.requestFullscreen();
      console.info('[editor transport] fullscreen requested');
    } catch (err) {
      console.warn('[editor transport] fullscreen failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [playerRef]);

  return (
    <div className="editor-panel-flat flex items-center justify-between px-3 h-11 shrink-0">
      {/* Centered transport cluster ─────────────────────── */}
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          className="editor-icon-btn"
          onClick={skipPrev}
          title="Previous shot boundary"
          aria-label="Previous shot"
        >
          <SkipBack size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="editor-icon-btn"
          onClick={togglePlay}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          style={{
            color: playing ? 'var(--editor-accent)' : 'var(--fg)',
            background: playing ? 'var(--editor-accent-soft)' : 'transparent',
            width: 36,
            height: 36,
          }}
        >
          {playing ? <Pause size={18} strokeWidth={2} /> : <Play size={18} strokeWidth={2} fill="currentColor" />}
        </button>
        <button
          type="button"
          className="editor-icon-btn"
          onClick={skipNext}
          title="Next shot boundary"
          aria-label="Next shot"
        >
          <SkipForward size={16} strokeWidth={2} />
        </button>

        <div className="text-[11px] tabular-nums ed-mono px-3" style={{ color: 'var(--fg-muted)' }}>
          <span style={{ color: 'var(--fg)' }}>{fmtClock(playheadMs)}</span>
          <span> / {fmtClock(totalDurationMs)}</span>
        </div>

        <select
          value={playbackRate}
          onChange={(e) => changeRate(Number(e.target.value) as PlaybackRate)}
          className="editor-btn"
          style={{ height: 28, paddingTop: 0, paddingBottom: 0 }}
          aria-label="Playback rate"
          title="Playback rate"
        >
          {PLAYBACK_RATES.map((r) => (
            <option key={r} value={r}>{r}x</option>
          ))}
        </select>
      </div>

      {/* Fullscreen right-aligned ───────────────────────── */}
      <div className="flex-1 flex justify-end">
        <button
          type="button"
          className="editor-icon-btn"
          onClick={requestFullscreen}
          title="Fullscreen preview"
          aria-label="Fullscreen"
        >
          <Maximize2 size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
