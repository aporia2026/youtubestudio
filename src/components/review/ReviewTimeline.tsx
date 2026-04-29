'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import type { ReviewComment } from './ReviewPage';

interface ReviewTimelineProps {
  currentTimeMs: number;
  durationMs: number;
  comments: ReviewComment[];
  onSeek: (ms: number) => void;
  /** Optional: when provided, a YouTube-style frame preview pops up on hover. */
  videoUrl?: string | null;
  /** Optional: percent of the video the browser has buffered (0–100). Renders a
   *  YouTube-style "downloaded" track behind the progress fill so the user can
   *  see how much is ready to play. */
  bufferedPct?: number;
}

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ReviewTimeline({ currentTimeMs, durationMs, comments, onSeek, videoUrl, bufferedPct }: ReviewTimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // Frame-preview state. Hidden <video> seeks to the hover time; a popup
  // canvas paints the current frame above the cursor (YouTube-style).
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const seekRafRef = useRef<number | null>(null);
  const [hover, setHover] = useState<{ ms: number; xPx: number; barWidth: number } | null>(null);

  // Throttled seek of the preview video to the hovered timestamp. We coalesce
  // mousemove → one seek per animation frame so we don't thrash the decoder.
  useEffect(() => {
    if (!hover || !previewVideoRef.current) return;
    if (seekRafRef.current != null) cancelAnimationFrame(seekRafRef.current);
    seekRafRef.current = requestAnimationFrame(() => {
      const v = previewVideoRef.current;
      if (!v) return;
      const t = hover.ms / 1000;
      // Some browsers throw if currentTime is set before metadata loads.
      if (Number.isFinite(t) && v.readyState >= 1) {
        try { v.currentTime = t; } catch {}
      }
    });
    return () => {
      if (seekRafRef.current != null) cancelAnimationFrame(seekRafRef.current);
    };
  }, [hover]);

  // Repaint the canvas whenever the hidden video finishes seeking.
  useEffect(() => {
    const v = previewVideoRef.current;
    const c = previewCanvasRef.current;
    if (!v || !c) return;
    function paint() {
      const v = previewVideoRef.current;
      const c = previewCanvasRef.current;
      if (!v || !c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      try { ctx.drawImage(v, 0, 0, c.width, c.height); } catch {}
    }
    v.addEventListener('seeked', paint);
    v.addEventListener('loadeddata', paint);
    return () => {
      v.removeEventListener('seeked', paint);
      v.removeEventListener('loadeddata', paint);
    };
  }, [videoUrl]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar || !durationMs) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(Math.round(pct * durationMs));
  }, [durationMs, onSeek]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar || !durationMs) return;
    const rect = bar.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, xPx / rect.width));
    setHover({ ms: Math.round(pct * durationMs), xPx, barWidth: rect.width });
  }, [durationMs]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const progress = durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0;

  // Top-level (non-reply) comments visualised on the timeline:
  //  - point comments → small dot at timestamp_ms
  //  - range comments → translucent bar from timestamp_ms..end_timestamp_ms
  // Stacked vertically when overlapping so they're all clickable.
  const topLevel = comments.filter(c => !c.parent_id);
  const ranges = topLevel
    .filter(c => c.end_timestamp_ms != null && c.end_timestamp_ms > c.timestamp_ms)
    .map((c, i) => ({
      id: c.id,
      startPct: durationMs > 0 ? (c.timestamp_ms / durationMs) * 100 : 0,
      endPct: durationMs > 0 ? (c.end_timestamp_ms! / durationMs) * 100 : 0,
      color: c.author_color,
      resolved: c.resolved,
      lane: i % 3, // up to 3 visual lanes so overlapping ranges don't all stack
      timestampMs: c.timestamp_ms,
      endMs: c.end_timestamp_ms!,
    }));
  const points = topLevel
    .filter(c => c.end_timestamp_ms == null || c.end_timestamp_ms <= c.timestamp_ms)
    .map(c => ({
      id: c.id,
      pct: durationMs > 0 ? (c.timestamp_ms / durationMs) * 100 : 0,
      color: c.author_color,
      hasDrawing: !!c.drawing_data,
      resolved: c.resolved,
      timestampMs: c.timestamp_ms,
    }));

  return (
    <div className="px-4 py-3 shrink-0" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
      {/* Time display */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(currentTimeMs)}</span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(durationMs)}</span>
      </div>

      {/* Range comment bars — sit just above the scrub bar so they don't fight
          for click events with the bar itself. Hover/click jumps to start. */}
      {ranges.length > 0 && (
        <div className="relative h-3 mb-1">
          {ranges.map(r => (
            <button
              key={r.id}
              onClick={() => onSeek(r.timestampMs)}
              className="absolute h-1 rounded-full transition-opacity hover:opacity-100 cursor-pointer"
              style={{
                left: `${r.startPct}%`,
                width: `${Math.max(1, r.endPct - r.startPct)}%`,
                top: r.lane * 4,
                background: r.color,
                opacity: r.resolved ? 0.25 : 0.7,
                boxShadow: r.resolved ? 'none' : `0 0 6px ${r.color}55`,
              }}
              title={`Range comment ${formatTime(r.timestampMs)}–${formatTime(r.endMs)} — click to jump to start`}
            />
          ))}
        </div>
      )}

      {/* Progress bar */}
      <div
        ref={barRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="relative h-2 rounded-full cursor-pointer group"
        style={{ background: 'rgba(255,255,255,0.1)' }}
      >
        {/* Buffered fill — sits beneath the progress gradient so the viewer
            sees how much of the video is ready ahead of the playhead. */}
        {typeof bufferedPct === 'number' && bufferedPct > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
            style={{ width: `${Math.min(100, bufferedPct)}%`, background: 'rgba(255,255,255,0.18)' }}
          />
        )}

        {/* Hidden seekable <video> used purely as a frame source for the
            preview canvas. Muted + preload=auto so seeks resolve quickly. */}
        {videoUrl && (
          <video
            ref={previewVideoRef}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            style={{ display: 'none' }}
          />
        )}

        {/* Hover preview popup */}
        {videoUrl && hover && durationMs > 0 && (() => {
          const previewW = 160;
          const previewH = 90;
          // Clamp horizontally so the popup doesn't overflow the bar.
          const half = previewW / 2;
          const left = Math.max(half, Math.min(hover.barWidth - half, hover.xPx));
          return (
            <div
              className="absolute pointer-events-none"
              style={{
                left,
                bottom: '24px',
                transform: 'translateX(-50%)',
                zIndex: 20,
              }}
            >
              <div
                className="rounded-md overflow-hidden"
                style={{
                  background: '#000',
                  border: '1px solid rgba(255,255,255,0.18)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  width: previewW,
                  height: previewH,
                }}
              >
                <canvas
                  ref={previewCanvasRef}
                  width={previewW}
                  height={previewH}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />
              </div>
              <div
                className="text-[10px] font-mono text-center mt-1 px-1.5 py-0.5 rounded inline-block"
                style={{
                  position: 'relative',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(0,0,0,0.7)',
                  color: '#fff',
                }}
              >
                {formatTime(hover.ms)}
              </div>
            </div>
          );
        })()}

        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow-lg"
          style={{ left: `${progress}%`, transform: 'translate(-50%, -50%)', background: '#7c3aed' }}
        />

        {/* Point markers */}
        {points.map(marker => (
          <button
            key={marker.id}
            onClick={e => { e.stopPropagation(); onSeek(marker.timestampMs); }}
            className="absolute top-1/2 -translate-y-1/2 transition-transform hover:scale-150 cursor-pointer"
            style={{ left: `${marker.pct}%`, transform: 'translate(-50%, -50%)' }}
            title={`Comment at ${formatTime(marker.timestampMs)}`}
          >
            {marker.hasDrawing ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill={marker.resolved ? 'rgba(255,255,255,0.3)' : marker.color} stroke="none">
                <path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              </svg>
            ) : (
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: marker.resolved ? 'rgba(255,255,255,0.3)' : marker.color,
                  boxShadow: marker.resolved ? 'none' : `0 0 4px ${marker.color}`,
                }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
