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
}

export const ReviewPlayer = forwardRef<HTMLVideoElement, ReviewPlayerProps>(
  function ReviewPlayer({ src, onTimeUpdate, isDrawing, onDrawingToggle, onDrawingComplete, canAnnotate }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [videoDims, setVideoDims] = useState({ width: 0, height: 0 });

    useImperativeHandle(ref, () => videoRef.current!);

    const togglePlay = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) {
        v.play();
        setPlaying(true);
        // Exit drawing mode on play
        if (isDrawing) onDrawingToggle(false);
      } else {
        v.pause();
        setPlaying(false);
      }
    }, [isDrawing, onDrawingToggle]);

    const toggleFullscreen = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        el.requestFullscreen();
      }
    }, []);

    useEffect(() => {
      function onFsChange() {
        setFullscreen(!!document.fullscreenElement);
      }
      document.addEventListener('fullscreenchange', onFsChange);
      return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
      function onKey(e: KeyboardEvent) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.code === 'KeyF') toggleFullscreen();
        if (e.code === 'KeyM') {
          setMuted(m => !m);
          if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
        }
        if (e.code === 'ArrowLeft' && videoRef.current) {
          videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
        }
        if (e.code === 'ArrowRight' && videoRef.current) {
          videoRef.current.currentTime += 5;
        }
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, toggleFullscreen]);

    function handleTimeUpdate() {
      if (videoRef.current) {
        onTimeUpdate(Math.round(videoRef.current.currentTime * 1000));
      }
    }

    function handleLoadedMetadata() {
      if (videoRef.current) {
        setVideoDims({ width: videoRef.current.videoWidth, height: videoRef.current.videoHeight });
      }
    }

    const rates = [0.5, 1, 1.5, 2];

    return (
      <div ref={containerRef} className="relative flex-1 bg-black flex items-center justify-center group">
        <video
          ref={videoRef}
          src={src}
          crossOrigin="anonymous"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onDoubleClick={toggleFullscreen}
          className="max-w-full max-h-full"
          style={{ cursor: isDrawing ? 'crosshair' : 'pointer' }}
          onClick={isDrawing ? undefined : togglePlay}
          playsInline
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

        {/* Controls bar */}
        <div
          className="absolute bottom-0 left-0 right-0 px-4 py-2 flex items-center gap-3 transition-opacity"
          style={{
            background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
            opacity: playing ? 0 : 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={e => { if (playing) e.currentTarget.style.opacity = '0'; }}
        >
          {/* Play/Pause */}
          <button onClick={togglePlay} className="text-white hover:text-purple-400 transition-colors">
            {playing ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            )}
          </button>

          {/* Volume */}
          <div className="flex items-center gap-1">
            <button onClick={() => { setMuted(m => !m); if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }} className="text-white hover:text-purple-400">
              {muted || volume === 0 ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
              )}
            </button>
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

          {/* Playback rate */}
          <button
            onClick={() => {
              const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
              const rate = rates[nextIdx];
              setPlaybackRate(rate);
              if (videoRef.current) videoRef.current.playbackRate = rate;
            }}
            className="text-xs font-mono text-white hover:text-purple-400 px-1"
          >
            {playbackRate}x
          </button>

          <div className="flex-1" />

          {/* Annotate button */}
          {canAnnotate && !playing && (
            <button
              onClick={() => onDrawingToggle(!isDrawing)}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors"
              style={{
                background: isDrawing ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.1)',
                color: isDrawing ? '#a78bfa' : 'white',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" />
                <circle cx="11" cy="11" r="2" />
              </svg>
              {isDrawing ? 'Drawing...' : 'Annotate'}
            </button>
          )}

          {/* Fullscreen */}
          <button onClick={toggleFullscreen} className="text-white hover:text-purple-400 transition-colors">
            {fullscreen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            )}
          </button>
        </div>
      </div>
    );
  }
);
