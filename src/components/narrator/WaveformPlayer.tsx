'use client';

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

export interface TakeCommentMarker {
  id: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  author_color: string;
  resolved: boolean;
  /** Lane index 0..2 — used when several markers overlap, so they don't all
   *  stack on top of each other. Caller computes this. */
  lane?: number;
}

export interface WaveformPlayerHandle {
  /** Seek to ms (clamped to [0, duration]). */
  seek: (ms: number) => void;
  /** Toggle playback. */
  togglePlay: () => void;
  /** Current time in ms (live read; useful right before posting a comment). */
  getCurrentMs: () => number;
}

interface WaveformPlayerProps {
  src: string;
  /** ms — if known up front (from DB), used until the file decodes. */
  initialDurationMs?: number | null;
  comments: TakeCommentMarker[];
  onTimeUpdate: (ms: number) => void;
  onDurationChange?: (ms: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  /** Triggered whenever a marker is clicked — caller can highlight the
   *  matching item in the comment list. */
  onMarkerClick?: (commentId: string, ms: number) => void;
  /** Optional play-rate (1 = normal). Lets the owner slow down to listen
   *  for stumbles. Defaults to 1. */
  playbackRate?: number;
}

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * wavesurfer-backed audio player tuned for review:
 *   - waveform with progress fill
 *   - point + range comment markers along the timeline
 *   - keyboard: space (play/pause), ←/→ (jump 5s), J/K/L
 *   - exposes seek() / togglePlay() / getCurrentMs() via ref so parent
 *     components (CommentInput, ScriptFollow) can drive playback
 *
 * The element MUST be wrapped in a 'use client' boundary because wavesurfer
 * touches `window`. wavesurfer 7+ ships ESM and works without a React adapter.
 */
export const WaveformPlayer = forwardRef<WaveformPlayerHandle, WaveformPlayerProps>(function WaveformPlayer(
  { src, initialDurationMs, comments, onTimeUpdate, onDurationChange, onPlayStateChange, onMarkerClick, playbackRate = 1 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(initialDurationMs || 0);
  const [ready, setReady] = useState(false);
  // Surface loading progress + load failures. Without these the user just
  // sees an endless spinner whenever R2 CORS is misconfigured or the
  // network stalls — wavesurfer offers no built-in UI for either case.
  const [loadPct, setLoadPct] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Reload trigger: bump on retry so the [src, reloadKey] effect remounts wavesurfer.
  const [reloadKey, setReloadKey] = useState(0);

  // Mount wavesurfer once per src. Tearing down on src change avoids the
  // common "second take plays the first take's waveform" bug.
  useEffect(() => {
    if (!containerRef.current) return;
    if (!src) {
      setLoadError('No audio URL — the upload may not have completed yet.');
      return;
    }
    setReady(false);
    setLoadPct(0);
    setLoadError(null);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: 'rgba(167,139,250,0.45)',
      progressColor: '#7c3aed',
      cursorColor: '#a78bfa',
      cursorWidth: 2,
      height: 64,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      url: src,
      // Explicit CORS request so the browser sends an Origin header and the
      // R2 response's Access-Control-Allow-Origin is honoured. Without this
      // some environments fall back to no-cors which silently breaks the
      // audio decode.
      fetchParams: { mode: 'cors', credentials: 'omit' },
    });
    wsRef.current = ws;

    const onReady = () => {
      setReady(true);
      setLoadPct(100);
      const d = ws.getDuration() * 1000;
      setDurationMs(d);
      onDurationChange?.(d);
      ws.setPlaybackRate(playbackRate);
    };
    const onLoading = (pct: number) => {
      // wavesurfer emits 0..100 during the fetch+decode pipeline.
      setLoadPct(typeof pct === 'number' ? pct : 0);
    };
    const onError = (err: Error | unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('WaveformPlayer load error:', err);
      // CORS failures from fetch surface as a TypeError with "Failed to fetch"
      // in Chrome / "NetworkError when attempting to fetch resource" in
      // Firefox. Surface a hint so the user knows where to look.
      const looksLikeCors = /failed to fetch|networkerror|cors/i.test(msg);
      setLoadError(looksLikeCors
        ? 'Could not load the audio. This is usually a CORS issue on the R2 narration bucket — make sure GET requests from this origin are allowed.'
        : `Could not load the audio: ${msg}`);
    };
    const onAudioProcess = () => {
      const t = ws.getCurrentTime() * 1000;
      setCurrentMs(t);
      onTimeUpdate(t);
    };
    const onSeeking = () => {
      const t = ws.getCurrentTime() * 1000;
      setCurrentMs(t);
      onTimeUpdate(t);
    };
    const onPlay = () => { setPlaying(true); onPlayStateChange?.(true); };
    const onPause = () => { setPlaying(false); onPlayStateChange?.(false); };
    const onFinish = () => { setPlaying(false); onPlayStateChange?.(false); };

    ws.on('ready', onReady);
    ws.on('loading', onLoading);
    ws.on('error', onError);
    ws.on('audioprocess', onAudioProcess);
    ws.on('seeking', onSeeking);
    ws.on('play', onPlay);
    ws.on('pause', onPause);
    ws.on('finish', onFinish);

    // Watchdog: if neither 'ready' nor 'error' fires within 30s, the load
    // is genuinely stuck — surface a timeout error rather than spinning
    // forever. wavesurfer has no native timeout for this.
    const watchdog = setTimeout(() => {
      if (!wsRef.current) return;
      try {
        const dur = ws.getDuration();
        if (!Number.isFinite(dur) || dur <= 0) {
          onError(new Error('Timed out after 30s. Likely a CORS rejection or unreachable URL.'));
        }
      } catch {}
    }, 30000);

    return () => {
      clearTimeout(watchdog);
      try { ws.destroy(); } catch {}
      wsRef.current = null;
    };
    // We intentionally ignore the callbacks in deps — they're stable from the
    // parent's perspective and re-mounting wavesurfer for a callback identity
    // change would discard the decoded buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, reloadKey]);

  // Apply playbackRate changes without remounting.
  useEffect(() => {
    if (wsRef.current && ready) {
      wsRef.current.setPlaybackRate(playbackRate);
    }
  }, [playbackRate, ready]);

  const seek = useCallback((ms: number) => {
    const ws = wsRef.current;
    if (!ws) return;
    const dur = ws.getDuration();
    if (!Number.isFinite(dur) || dur <= 0) return;
    const target = Math.max(0, Math.min(dur, ms / 1000));
    ws.setTime(target);
  }, []);

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) ws.pause();
    else ws.play();
  }, []);

  const getCurrentMs = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return currentMs;
    return ws.getCurrentTime() * 1000;
  }, [currentMs]);

  useImperativeHandle(ref, () => ({ seek, togglePlay, getCurrentMs }), [seek, togglePlay, getCurrentMs]);

  // Keyboard shortcuts — only when the player is focused so we don't fight
  // the comment textarea.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      seek(getCurrentMs() - 5000);
    } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      seek(getCurrentMs() + 5000);
    }
  }, [togglePlay, seek, getCurrentMs]);

  // Marker placement. wavesurfer renders the waveform as a child of
  // containerRef, so we lay markers absolutely on top of the same wrapper.
  const points = comments.filter(c => c.end_timestamp_ms == null || c.end_timestamp_ms <= c.timestamp_ms);
  const ranges = comments.filter(c => c.end_timestamp_ms != null && c.end_timestamp_ms > c.timestamp_ms);

  return (
    <div className="space-y-2 outline-none" tabIndex={0} onKeyDown={onKeyDown}>
      {/* Range bars sit above the waveform so click-to-jump on a range
          doesn't conflict with wavesurfer's click-to-seek on the waveform. */}
      {ranges.length > 0 && durationMs > 0 && (
        <div className="relative h-3 px-1">
          {ranges.map(r => {
            const startPct = (r.timestamp_ms / durationMs) * 100;
            const endPct = (r.end_timestamp_ms! / durationMs) * 100;
            return (
              <button
                key={r.id}
                onClick={() => { seek(r.timestamp_ms); onMarkerClick?.(r.id, r.timestamp_ms); }}
                className="absolute h-1 rounded-full transition-opacity hover:opacity-100 cursor-pointer"
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(1, endPct - startPct)}%`,
                  top: (r.lane ?? 0) * 4,
                  background: r.author_color,
                  opacity: r.resolved ? 0.3 : 0.75,
                  boxShadow: r.resolved ? 'none' : `0 0 6px ${r.author_color}55`,
                }}
                title={`Range ${formatTime(r.timestamp_ms)}–${formatTime(r.end_timestamp_ms!)} — click to jump`}
              />
            );
          })}
        </div>
      )}

      {/* Waveform + point markers. The relative parent keeps markers aligned
          to the same width wavesurfer is rendering into. */}
      <div className="relative">
        <div ref={containerRef} className="w-full rounded-md overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)' }} />

        {/* Error state — visible instead of an endless spinner when the audio
            fails to load. Most common cause is R2 bucket CORS that allows
            PUT (for the upload) but not GET (for wavesurfer's fetch). */}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
            <div className="text-[11px] leading-snug" style={{ color: '#fca5a5' }}>
              {loadError}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setReloadKey(k => k + 1)}
                className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}
              >
                Retry
              </button>
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
                title="Open the URL directly to verify it's reachable"
              >
                Open URL
              </a>
            </div>
          </div>
        )}

        {/* Loading progress — only shown while wavesurfer is actively
            fetching/decoding. Replaces the indeterminate spinner so slow
            networks don't look broken. */}
        {!ready && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center gap-3 pointer-events-none">
            <div className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
            <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {loadPct > 0 ? `Loading ${Math.round(loadPct)}%` : 'Loading…'}
            </span>
          </div>
        )}

        {/* Point markers — pinned to the bottom of the waveform so they don't
            obscure the wave shape. */}
        {durationMs > 0 && points.map(m => {
          const pct = (m.timestamp_ms / durationMs) * 100;
          return (
            <button
              key={m.id}
              onClick={() => { seek(m.timestamp_ms); onMarkerClick?.(m.id, m.timestamp_ms); }}
              className="absolute bottom-0 w-2 h-2 rounded-full transition-transform hover:scale-150 cursor-pointer pointer-events-auto"
              style={{
                left: `${pct}%`,
                transform: 'translate(-50%, 50%)',
                background: m.resolved ? 'rgba(255,255,255,0.4)' : m.author_color,
                boxShadow: m.resolved ? 'none' : `0 0 5px ${m.author_color}`,
              }}
              title={`Comment at ${formatTime(m.timestamp_ms)} — click to jump`}
            />
          );
        })}
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={!ready}
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors disabled:opacity-50"
          style={{ background: playing ? '#7c3aed' : 'rgba(124,58,237,0.2)' }}
          title={playing ? 'Pause (space)' : 'Play (space)'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#a78bfa"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          )}
        </button>
        <button
          onClick={() => seek(getCurrentMs() - 5000)}
          disabled={!ready}
          className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-40"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
          title="Back 5s (←/J)"
        >
          ◀ 5s
        </button>
        <button
          onClick={() => seek(getCurrentMs() + 5000)}
          disabled={!ready}
          className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-40"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
          title="Forward 5s (→/L)"
        >
          5s ▶
        </button>
        <span className="text-[11px] font-mono ml-auto" style={{ color: 'var(--text-muted)' }}>
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </span>
      </div>
    </div>
  );
});
