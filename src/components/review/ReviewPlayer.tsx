'use client';

import { forwardRef, useRef, useState, useEffect, useCallback, useImperativeHandle } from 'react';
import { CanvasOverlay } from './CanvasOverlay';

interface ReviewPlayerProps {
  src: string;
  onTimeUpdate: (ms: number) => void;
  isDrawing: boolean;
  onDrawingToggle: (drawing: boolean) => void;
  onDrawingComplete: (data: unknown, thumbnail: string) => void;
  canAnnotate: boolean;
  /** Optional: timestamps (ms) of top-level comments. Enables prev/next-comment jump. */
  commentTimestamps?: number[];
  /** Lifts the buffered-percent so the timeline can render a buffered-progress bar. */
  onBufferedChange?: (pct: number) => void;
}

// All available playback speeds. The center of gravity is 1×; the extremes
// (0.25× and 4×) are there for frame-precise review and skim respectively.
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

// Frame stepping cadence. We don't actually know the source FPS without
// parsing the container, so we approximate at 30fps (≈33.3ms). Most editorial
// review footage is 24/30/60fps and a single step at 30fps lands within one
// frame in either direction — close enough for review-grade scrubbing.
const FRAME_STEP_S = 1 / 30;

function formatTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export const ReviewPlayer = forwardRef<HTMLVideoElement, ReviewPlayerProps>(
  function ReviewPlayer({ src, onTimeUpdate, isDrawing, onDrawingToggle, onDrawingComplete, canAnnotate, commentTimestamps, onBufferedChange }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);
    const [pip, setPip] = useState(false);
    const [videoDims, setVideoDims] = useState({ width: 0, height: 0 });
    const [currentTimeS, setCurrentTimeS] = useState(0);
    const [durationS, setDurationS] = useState(0);
    const [showHelp, setShowHelp] = useState(false);

    // A-B loop. When both points are set, the player auto-rewinds to `loopA`
    // every time playback crosses `loopB`. Useful for hammering a single
    // tricky moment over and over while reviewing.
    const [loopA, setLoopA] = useState<number | null>(null);
    const [loopB, setLoopB] = useState<number | null>(null);

    // Buffering / stall recovery state. We surface a spinner whenever the
    // browser fires `waiting` or `stalled`, and if the stall persists past
    // STALL_RECOVERY_MS we try a tiny nudge-seek to kick the loader back
    // into life. Tracks last-played-time so multi-pass nudges don't bounce.
    const [buffering, setBuffering] = useState(false);
    const [bufferedPct, setBufferedPct] = useState(0);
    const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stallAttemptsRef = useRef(0);

    // Floating "+10s" / "1.5×" / "Loop A set" toast — shown briefly when a
    // keyboard shortcut fires, so the user gets visual confirmation that a
    // headless action took effect.
    const [actionToast, setActionToast] = useState<{ id: number; text: string } | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashAction = useCallback((text: string) => {
      const id = Date.now();
      setActionToast({ id, text });
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        setActionToast(curr => (curr && curr.id === id ? null : curr));
      }, 700);
    }, []);

    useImperativeHandle(ref, () => videoRef.current!);

    // ---------------------------------------------------------------------
    // Core transport actions (each also fires a toast so keyboard usage
    // gets the same visual feedback as button clicks).
    // ---------------------------------------------------------------------
    const togglePlay = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) {
        v.play();
        setPlaying(true);
        if (isDrawing) onDrawingToggle(false);
      } else {
        v.pause();
        setPlaying(false);
      }
    }, [isDrawing, onDrawingToggle]);

    const skipBy = useCallback((deltaS: number) => {
      const v = videoRef.current;
      if (!v) return;
      const clamped = Math.max(0, Math.min((v.duration || Infinity), v.currentTime + deltaS));
      v.currentTime = clamped;
      const sign = deltaS >= 0 ? '+' : '−';
      const abs = Math.abs(deltaS);
      const txt = abs >= 1 ? `${sign}${abs.toFixed(0)}s` : `${sign}1 frame`;
      flashAction(txt);
    }, [flashAction]);

    const stepFrame = useCallback((dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      // Frame-stepping only makes sense while paused.
      if (!v.paused) v.pause();
      v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + dir * FRAME_STEP_S));
      flashAction(dir === 1 ? '▶ 1 frame' : '◀ 1 frame');
    }, [flashAction]);

    const setRate = useCallback((rate: number) => {
      setPlaybackRate(rate);
      if (videoRef.current) videoRef.current.playbackRate = rate;
      flashAction(`${rate}×`);
    }, [flashAction]);

    const cycleRate = useCallback((dir: 1 | -1) => {
      const idx = RATES.indexOf(playbackRate);
      const next = RATES[Math.max(0, Math.min(RATES.length - 1, idx + dir))];
      setRate(next);
    }, [playbackRate, setRate]);

    const toggleMute = useCallback(() => {
      const next = !muted;
      setMuted(next);
      if (videoRef.current) videoRef.current.muted = next;
      flashAction(next ? '🔇 Muted' : '🔊 Unmuted');
    }, [muted, flashAction]);

    const adjustVolume = useCallback((delta: number) => {
      const next = Math.max(0, Math.min(1, volume + delta));
      setVolume(next);
      setMuted(next === 0);
      if (videoRef.current) {
        videoRef.current.volume = next;
        videoRef.current.muted = next === 0;
      }
      flashAction(`Vol ${Math.round(next * 100)}%`);
    }, [volume, flashAction]);

    const toggleFullscreen = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen();
    }, []);

    const togglePip = useCallback(async () => {
      const v = videoRef.current;
      if (!v) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if ('requestPictureInPicture' in v) {
          await v.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP unavailable:', err);
      }
    }, []);

    const seekToPercent = useCallback((pct: number) => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      v.currentTime = pct * v.duration;
    }, []);

    // Snapshot: render the current frame to a canvas and trigger a download.
    // Falls back gracefully if the video taints the canvas (CORS).
    const takeSnapshot = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 1280;
      c.height = v.videoHeight || 720;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      try {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `frame-${formatTime(v.currentTime).replace(':', 'm')}s.png`;
        a.click();
        flashAction('📷 Snapshot');
      } catch {
        flashAction('📷 Snapshot blocked (CORS)');
      }
    }, [flashAction]);

    // A-B loop helpers. `I` sets in-point at current time, `O` sets out-point
    // (or clears if already past the in-point). The auto-rewind happens in
    // the timeUpdate handler below.
    const setLoopIn = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      setLoopA(v.currentTime);
      flashAction('⤵ Loop in');
    }, [flashAction]);
    const setLoopOut = useCallback(() => {
      const v = videoRef.current;
      if (!v || loopA == null) { flashAction('Set in-point first (I)'); return; }
      if (v.currentTime <= loopA) { flashAction('Out must be after in'); return; }
      setLoopB(v.currentTime);
      flashAction('⤴ Loop out');
    }, [loopA, flashAction]);
    const clearLoop = useCallback(() => {
      setLoopA(null); setLoopB(null);
      flashAction('Loop cleared');
    }, [flashAction]);

    const jumpToComment = useCallback((dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v || !commentTimestamps || commentTimestamps.length === 0) {
        flashAction('No comments');
        return;
      }
      const sorted = [...commentTimestamps].sort((a, b) => a - b);
      const nowMs = v.currentTime * 1000;
      const target = dir === 1
        ? sorted.find(t => t > nowMs + 250) // +250ms slop so we don't bounce
        : [...sorted].reverse().find(t => t < nowMs - 250);
      if (target == null) {
        flashAction(dir === 1 ? 'No next comment' : 'No previous comment');
        return;
      }
      v.currentTime = target / 1000;
      flashAction(dir === 1 ? '⏭ Next comment' : '⏮ Prev comment');
    }, [commentTimestamps, flashAction]);

    // ---------------------------------------------------------------------
    // Lifecycle hooks
    // ---------------------------------------------------------------------
    useEffect(() => {
      function onFsChange() { setFullscreen(!!document.fullscreenElement); }
      document.addEventListener('fullscreenchange', onFsChange);
      return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      function onEnter() { setPip(true); }
      function onLeave() { setPip(false); }
      v.addEventListener('enterpictureinpicture', onEnter);
      v.addEventListener('leavepictureinpicture', onLeave);
      return () => {
        v.removeEventListener('enterpictureinpicture', onEnter);
        v.removeEventListener('leavepictureinpicture', onLeave);
      };
    }, []);

    // ---------------------------------------------------------------------
    // Robust playback / stall recovery
    //
    // Large MP4s (especially ones uploaded with the moov atom at the END
    // instead of the front) tend to stall mid-playback as the browser walks
    // through byte ranges. We do three things:
    //
    //   1. Show a buffering spinner whenever the browser fires `waiting` /
    //      `stalled` so the user knows it's not frozen.
    //   2. After STALL_RECOVERY_MS without progress, nudge the player by
    //      seeking to the same currentTime — this forces a fresh range
    //      request and almost always unsticks Chrome/Firefox.
    //   3. Mirror the buffered TimeRanges as a percentage so the timeline
    //      can visualise download progress (rendered in ReviewTimeline).
    // ---------------------------------------------------------------------
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const STALL_RECOVERY_MS = 3500;

      function clearStallTimer() {
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
      }
      function armStallTimer() {
        clearStallTimer();
        stallTimerRef.current = setTimeout(() => {
          const v = videoRef.current;
          if (!v || v.paused) return;
          // Cap recovery attempts so we don't infinite-loop on a truly broken
          // file. After 3 nudges, just leave the spinner up.
          if (stallAttemptsRef.current >= 3) return;
          stallAttemptsRef.current += 1;
          try {
            const t = v.currentTime;
            // Tiny back-and-forward to force a fresh range request.
            v.currentTime = Math.max(0, t - 0.05);
            // Promise-returning play() can reject if user paused mid-recovery.
            v.play().catch(() => {});
          } catch {}
        }, STALL_RECOVERY_MS);
      }

      function onWaiting() { setBuffering(true); armStallTimer(); }
      function onStalled() { setBuffering(true); armStallTimer(); }
      function onPlaying() { setBuffering(false); clearStallTimer(); stallAttemptsRef.current = 0; }
      function onCanPlay() { setBuffering(false); clearStallTimer(); }
      function onSeeking() { setBuffering(true); }
      function onSeeked() { setBuffering(false); }
      function onProgress() {
        const vid = videoRef.current;
        if (!vid) return;
        const ranges = vid.buffered;
        if (ranges.length === 0 || !vid.duration) return;
        // Find the range that contains currentTime (or the last one).
        let end = 0;
        for (let i = 0; i < ranges.length; i++) {
          if (ranges.start(i) <= vid.currentTime && ranges.end(i) > end) end = ranges.end(i);
        }
        if (end === 0) end = ranges.end(ranges.length - 1);
        const pct = (end / vid.duration) * 100;
        setBufferedPct(pct);
        onBufferedChange?.(pct);
      }
      function onError() {
        // Browser couldn't decode/load — typically a transient network blip
        // on R2. Try one reload after a beat.
        const vid = videoRef.current;
        if (!vid) return;
        if (stallAttemptsRef.current >= 3) return;
        stallAttemptsRef.current += 1;
        const t = vid.currentTime;
        try {
          vid.load();
          vid.currentTime = t;
          vid.play().catch(() => {});
        } catch {}
      }

      v.addEventListener('waiting', onWaiting);
      v.addEventListener('stalled', onStalled);
      v.addEventListener('playing', onPlaying);
      v.addEventListener('canplay', onCanPlay);
      v.addEventListener('canplaythrough', onCanPlay);
      v.addEventListener('seeking', onSeeking);
      v.addEventListener('seeked', onSeeked);
      v.addEventListener('progress', onProgress);
      v.addEventListener('error', onError);
      return () => {
        clearStallTimer();
        v.removeEventListener('waiting', onWaiting);
        v.removeEventListener('stalled', onStalled);
        v.removeEventListener('playing', onPlaying);
        v.removeEventListener('canplay', onCanPlay);
        v.removeEventListener('canplaythrough', onCanPlay);
        v.removeEventListener('seeking', onSeeking);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('progress', onProgress);
        v.removeEventListener('error', onError);
      };
    }, [src]);

    // Comprehensive keyboard shortcuts (YouTube-flavored + extras).
    useEffect(() => {
      function onKey(e: KeyboardEvent) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if ((e.target as HTMLElement)?.isContentEditable) return;
        const k = e.key;
        const code = e.code;

        if (code === 'Space' || k.toLowerCase() === 'k') { e.preventDefault(); togglePlay(); return; }
        if (k.toLowerCase() === 'j') { e.preventDefault(); skipBy(-10); return; }
        if (k.toLowerCase() === 'l') { e.preventDefault(); skipBy(10); return; }

        if (code === 'ArrowLeft') {
          e.preventDefault();
          if (e.shiftKey) stepFrame(-1);
          else if (e.ctrlKey || e.metaKey) skipBy(-30);
          else skipBy(-5);
          return;
        }
        if (code === 'ArrowRight') {
          e.preventDefault();
          if (e.shiftKey) stepFrame(1);
          else if (e.ctrlKey || e.metaKey) skipBy(30);
          else skipBy(5);
          return;
        }
        if (code === 'ArrowUp') { e.preventDefault(); adjustVolume(0.1); return; }
        if (code === 'ArrowDown') { e.preventDefault(); adjustVolume(-0.1); return; }
        if (k === ',') { e.preventDefault(); stepFrame(-1); return; }
        if (k === '.') { e.preventDefault(); stepFrame(1); return; }
        if (k === '<') { e.preventDefault(); cycleRate(-1); return; }
        if (k === '>') { e.preventDefault(); cycleRate(1); return; }

        if (k.toLowerCase() === 'm') { e.preventDefault(); toggleMute(); return; }
        if (k.toLowerCase() === 'f') { e.preventDefault(); toggleFullscreen(); return; }
        if (k.toLowerCase() === 'p') { e.preventDefault(); togglePip(); return; }
        if (k.toLowerCase() === 's') { e.preventDefault(); takeSnapshot(); return; }
        if (k.toLowerCase() === 'i') { e.preventDefault(); setLoopIn(); return; }
        if (k.toLowerCase() === 'o') { e.preventDefault(); setLoopOut(); return; }
        if (k.toLowerCase() === 'x') { e.preventDefault(); clearLoop(); return; }
        if (k.toLowerCase() === 'n') { e.preventDefault(); jumpToComment(1); return; }
        if (k.toLowerCase() === 'b') { e.preventDefault(); jumpToComment(-1); return; }
        if (k === '?' || k === '/') { e.preventDefault(); setShowHelp(s => !s); return; }
        if (k === 'Escape') { setShowHelp(false); setShowSpeedMenu(false); return; }

        // 0–9 → seek to N×10% of duration (YouTube convention).
        if (/^[0-9]$/.test(k)) {
          e.preventDefault();
          seekToPercent(parseInt(k, 10) / 10);
          return;
        }
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, skipBy, stepFrame, adjustVolume, toggleMute, toggleFullscreen, togglePip, takeSnapshot, setLoopIn, setLoopOut, clearLoop, jumpToComment, cycleRate, seekToPercent]);

    function handleTimeUpdate() {
      const v = videoRef.current;
      if (!v) return;
      onTimeUpdate(Math.round(v.currentTime * 1000));
      setCurrentTimeS(v.currentTime);

      // A-B loop enforcement: if both endpoints set and we passed B, jump
      // back to A. Tiny epsilon avoids stutter at the boundary.
      if (loopA != null && loopB != null && v.currentTime + 0.02 >= loopB) {
        v.currentTime = loopA;
      }
    }

    function handleLoadedMetadata() {
      const v = videoRef.current;
      if (!v) return;
      setVideoDims({ width: v.videoWidth, height: v.videoHeight });
      setDurationS(v.duration || 0);
    }

    return (
      <div ref={containerRef} className="relative flex-1 bg-black flex items-center justify-center group select-none">
        <video
          ref={videoRef}
          src={src}
          // NOTE: no crossOrigin attribute. Setting it to "anonymous" requires
          // the R2 bucket to return matching Access-Control-Allow-Origin headers
          // on byte-range GETs, and a misconfiguration silently blocks playback
          // (you get duration metadata + a black frame). Trade-off: the canvas
          // annotation Done button can't composite the video frame into the
          // saved thumbnail, and snapshot/PiP frame access may be tainted.
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onDoubleClick={toggleFullscreen}
          className="max-w-full max-h-full"
          style={{ cursor: isDrawing ? 'crosshair' : 'pointer' }}
          onClick={isDrawing ? undefined : togglePlay}
          playsInline
          // Aggressive buffering. The default ('metadata') only fetches the
          // moov/header — fine for thumbnails, bad for smooth scrubbing on
          // large files. 'auto' tells the browser to buffer ahead as far as
          // network conditions allow, which is what reviewers want.
          preload="auto"
        />

        {/* Canvas overlay for annotations */}
        {canAnnotate && videoRef.current && (
          <CanvasOverlay
            videoRef={videoRef}
            isActive={isDrawing}
            videoDims={videoDims}
            onComplete={onDrawingComplete}
          />
        )}

        {/* Buffering spinner — shown while the browser is waiting on bytes.
            Sits behind the action toast so an active toast still wins. */}
        {buffering && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 25 }}>
            <div className="flex flex-col items-center gap-2">
              <div
                className="w-12 h-12 rounded-full border-4 border-t-transparent"
                style={{
                  borderColor: 'rgba(167,139,250,0.85)',
                  borderTopColor: 'transparent',
                  animation: 'reviewSpin 0.9s linear infinite',
                }}
              />
              <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                Buffering…
              </span>
            </div>
          </div>
        )}

        {/* Floating action toast (centered) */}
        {actionToast && (
          <div
            key={actionToast.id}
            className="absolute pointer-events-none flex items-center justify-center"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              animation: 'reviewToastFade 700ms ease-out forwards',
              zIndex: 30,
            }}
          >
            <div
              className="px-4 py-2 rounded-xl text-base font-semibold tracking-wide"
              style={{
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                backdropFilter: 'blur(6px)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              }}
            >
              {actionToast.text}
            </div>
          </div>
        )}

        {/* A-B loop badges in the top-right corner so they stay visible while
            playing (controls auto-hide). */}
        {(loopA != null || loopB != null) && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono"
               style={{ background: 'rgba(124,58,237,0.85)', color: '#fff', zIndex: 20 }}>
            <span>🔁</span>
            <span>{loopA != null ? formatTime(loopA) : '—'}</span>
            <span>↔</span>
            <span>{loopB != null ? formatTime(loopB) : '—'}</span>
            <button onClick={clearLoop} className="ml-1 opacity-70 hover:opacity-100" title="Clear loop (X)">✕</button>
          </div>
        )}

        {/* Help overlay */}
        {showHelp && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)', zIndex: 40 }} onClick={() => setShowHelp(false)}>
            <div className="rounded-xl p-6 max-w-md text-xs" style={{ background: '#0e0e14', border: '1px solid rgba(255,255,255,0.1)' }} onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-bold mb-3" style={{ color: '#a78bfa' }}>Keyboard shortcuts</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5" style={{ color: '#cbd5e1' }}>
                <Shortcut k="Space / K" v="Play / Pause" />
                <Shortcut k="J / L" v="−10s / +10s" />
                <Shortcut k="← / →" v="−5s / +5s" />
                <Shortcut k="Shift+← / →" v="Frame back / forward" />
                <Shortcut k=", / ." v="Frame back / forward" />
                <Shortcut k="Ctrl+← / →" v="−30s / +30s" />
                <Shortcut k="↑ / ↓" v="Volume up / down" />
                <Shortcut k="M" v="Mute" />
                <Shortcut k="< / >" v="Slower / Faster" />
                <Shortcut k="0–9" v="Seek to %" />
                <Shortcut k="I / O" v="Loop in / out" />
                <Shortcut k="X" v="Clear loop" />
                <Shortcut k="B / N" v="Prev / Next comment" />
                <Shortcut k="S" v="Snapshot frame" />
                <Shortcut k="P" v="Picture-in-picture" />
                <Shortcut k="F" v="Fullscreen" />
                <Shortcut k="?" v="This help" />
              </div>
              <p className="mt-3 text-[10px] text-center" style={{ color: '#64748b' }}>Click anywhere to close</p>
            </div>
          </div>
        )}

        {/* Controls bar */}
        <div
          className="absolute bottom-0 left-0 right-0 px-4 py-2 transition-opacity"
          style={{
            background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
            opacity: playing && !showSpeedMenu ? 0 : 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={e => { if (playing && !showSpeedMenu) e.currentTarget.style.opacity = '0'; }}
        >
          <div className="flex items-center gap-1">
            {/* Prev comment */}
            {commentTimestamps && commentTimestamps.length > 0 && (
              <CtrlButton onClick={() => jumpToComment(-1)} title="Previous comment (B)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
              </CtrlButton>
            )}
            {/* −10s */}
            <CtrlButton onClick={() => skipBy(-10)} title="Back 10s (J)">
              <RewindIcon n={10} />
            </CtrlButton>
            {/* −5s */}
            <CtrlButton onClick={() => skipBy(-5)} title="Back 5s (←)">
              <RewindIcon n={5} />
            </CtrlButton>
            {/* Frame back */}
            <CtrlButton onClick={() => stepFrame(-1)} title="Frame back (Shift+← / ,)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="11 19 2 12 11 5 11 19" /><rect x="13" y="5" width="2" height="14" /></svg>
            </CtrlButton>

            {/* Play / Pause (bigger) */}
            <button onClick={togglePlay} className="text-white hover:text-purple-300 transition-colors px-2" title="Play/Pause (Space, K)">
              {playing ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </button>

            {/* Frame forward */}
            <CtrlButton onClick={() => stepFrame(1)} title="Frame forward (Shift+→ / .)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 5 22 12 13 19 13 5" /><rect x="9" y="5" width="2" height="14" /></svg>
            </CtrlButton>
            {/* +5s */}
            <CtrlButton onClick={() => skipBy(5)} title="Forward 5s (→)">
              <FastForwardIcon n={5} />
            </CtrlButton>
            {/* +10s */}
            <CtrlButton onClick={() => skipBy(10)} title="Forward 10s (L)">
              <FastForwardIcon n={10} />
            </CtrlButton>
            {/* Next comment */}
            {commentTimestamps && commentTimestamps.length > 0 && (
              <CtrlButton onClick={() => jumpToComment(1)} title="Next comment (N)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L5.5 6v12z"/></svg>
              </CtrlButton>
            )}

            {/* Time */}
            <span className="text-[11px] font-mono ml-2 mr-1" style={{ color: 'rgba(255,255,255,0.85)' }}>
              {formatTime(currentTimeS)} <span style={{ color: 'rgba(255,255,255,0.4)' }}>/ {formatTime(durationS)}</span>
            </span>

            {/* Volume */}
            <div className="flex items-center gap-1 ml-2">
              <CtrlButton onClick={toggleMute} title="Mute (M)">
                {muted || volume === 0 ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
                )}
              </CtrlButton>
              <input
                type="range" min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                  if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
                }}
                className="w-16 accent-purple-500"
              />
            </div>

            <div className="flex-1" />

            {/* Speed picker */}
            <div className="relative">
              <button
                onClick={() => setShowSpeedMenu(s => !s)}
                className="text-xs font-mono text-white hover:text-purple-300 px-2 py-1 rounded"
                style={{ background: showSpeedMenu ? 'rgba(124,58,237,0.25)' : 'transparent' }}
                title="Playback speed (< >)"
              >
                {playbackRate}×
              </button>
              {showSpeedMenu && (
                <div className="absolute right-0 bottom-full mb-1 rounded-lg overflow-hidden" style={{ background: '#1a1a24', border: '1px solid rgba(255,255,255,0.1)', minWidth: 80, zIndex: 30 }}>
                  {RATES.map(r => (
                    <button
                      key={r}
                      onClick={() => { setRate(r); setShowSpeedMenu(false); }}
                      className="block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-white/5"
                      style={{ color: r === playbackRate ? '#a78bfa' : '#cbd5e1' }}
                    >
                      {r}×{r === 1 ? ' (normal)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Loop A / B */}
            <CtrlButton onClick={loopA != null && loopB != null ? clearLoop : (loopA == null ? setLoopIn : setLoopOut)} title="A-B loop (I sets in, O sets out, X clears)">
              <span className="text-[10px] font-bold" style={{ color: loopA != null ? '#a78bfa' : 'currentColor' }}>
                {loopA == null ? 'A↔B' : (loopB == null ? 'set B' : 'loop ✓')}
              </span>
            </CtrlButton>

            {/* Snapshot */}
            <CtrlButton onClick={takeSnapshot} title="Snapshot frame (S)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            </CtrlButton>

            {/* Picture-in-Picture */}
            <CtrlButton onClick={togglePip} title="Picture-in-picture (P)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="14" rx="2" />
                <rect x="13" y="11" width="7" height="5" fill={pip ? 'currentColor' : 'none'} />
              </svg>
            </CtrlButton>

            {/* Annotate */}
            {canAnnotate && !playing && (
              <button
                onClick={() => onDrawingToggle(!isDrawing)}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors"
                style={{ background: isDrawing ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.1)', color: isDrawing ? '#a78bfa' : 'white' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" />
                  <circle cx="11" cy="11" r="2" />
                </svg>
                {isDrawing ? 'Drawing...' : 'Annotate'}
              </button>
            )}

            {/* Help */}
            <CtrlButton onClick={() => setShowHelp(s => !s)} title="Keyboard shortcuts (?)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </CtrlButton>

            {/* Fullscreen */}
            <CtrlButton onClick={toggleFullscreen} title="Fullscreen (F)">
              {fullscreen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
              )}
            </CtrlButton>
          </div>
        </div>

        {/* Toast keyframes — kept inline so the component is self-contained. */}
        <style jsx>{`
          @keyframes reviewToastFade {
            0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
            15%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            70%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            100% { opacity: 0; transform: translate(-50%, -55%) scale(0.95); }
          }
          @keyframes reviewSpin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }
);

// ---------------------------------------------------------------------
// Local sub-components / icons
// ---------------------------------------------------------------------

function CtrlButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="text-white hover:text-purple-300 transition-colors px-1.5 py-1 rounded hover:bg-white/5 flex items-center justify-center"
      style={{ minWidth: 28, minHeight: 28 }}
    >
      {children}
    </button>
  );
}

function Shortcut({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="font-mono" style={{ color: '#a78bfa' }}>{k}</span>
      <span>{v}</span>
    </>
  );
}

// Rewind icon: ⏪ followed by a tiny number badge so users see "10" at a
// glance instead of needing to read a tooltip.
function RewindIcon({ n }: { n: number }) {
  return (
    <span className="relative flex items-center justify-center" style={{ width: 22, height: 16 }}>
      <svg width="18" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="11 19 2 12 11 5 11 19" /><polygon points="22 19 13 12 22 5 22 19" /></svg>
      <span className="absolute text-[7px] font-bold leading-none" style={{ right: -2, bottom: -1 }}>{n}</span>
    </span>
  );
}

function FastForwardIcon({ n }: { n: number }) {
  return (
    <span className="relative flex items-center justify-center" style={{ width: 22, height: 16 }}>
      <svg width="18" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 5 22 12 13 19 13 5" /><polygon points="2 5 11 12 2 19 2 5" /></svg>
      <span className="absolute text-[7px] font-bold leading-none" style={{ right: -2, bottom: -1 }}>{n}</span>
    </span>
  );
}
