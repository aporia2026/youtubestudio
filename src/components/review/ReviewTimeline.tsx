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

  // Frame-preview state. We render the preview <video> element directly in
  // the popup (no canvas) and seek it to the hover timestamp.
  //
  // Two prior bugs we're guarding against:
  //   1. `display:none` videos are skipped from decoding by Chrome — fixed
  //      by rendering the <video> in-place and toggling visibility via
  //      opacity instead of display.
  //   2. The popup was gating visibility on a `previewReady` flag that
  //      flipped true on the FIRST `loadeddata` (which fires at t=0). So it
  //      proudly displayed the 0:00 frame even while a seek to 2:53 was
  //      still in-flight. Now we track the *actual seeked-to time* and only
  //      show the frame when it matches the hover target (within tolerance).
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const [hover, setHover] = useState<{ ms: number; xPx: number; barWidth: number } | null>(null);
  // Last time the browser confirmed (via `seeked`) the video had landed at.
  // ms-precision so we can compare against `hover.ms`.
  const [seekedAtMs, setSeekedAtMs] = useState<number | null>(null);

  // Force the source to start loading the moment the URL is available, even
  // before the user hovers — that way the first hover doesn't have to wait
  // on a cold cache for metadata.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v || !videoUrl) return;
    try { v.load(); } catch {}
  }, [videoUrl]);

  // Set currentTime as soon as the hover changes. We deliberately do NOT
  // gate on readyState — browsers tolerate currentTime= before metadata
  // loads and queue the seek. We also don't rAF-coalesce; modern browsers
  // already merge rapid seeks, and rAF was hiding seeks behind a one-frame
  // delay that compounded the "stale frame" bug.
  useEffect(() => {
    if (!hover) return;
    const v = previewVideoRef.current;
    if (!v) return;
    const t = hover.ms / 1000;
    if (!Number.isFinite(t)) return;
    try { v.currentTime = t; } catch {}
  }, [hover]);

  // Track when each seek actually completes. Used to keep the popup hidden
  // until the displayed frame matches what the cursor is hovering over.
  useEffect(() => {
    setSeekedAtMs(null);
    const v = previewVideoRef.current;
    if (!v) return;
    function onSeeked() {
      const v = previewVideoRef.current;
      if (!v) return;
      setSeekedAtMs(Math.round(v.currentTime * 1000));
    }
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadeddata', onSeeked);
    return () => {
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadeddata', onSeeked);
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

        {/* Hover preview popup. The <video> is always mounted (so the browser
            keeps decoding frames), and we toggle visibility via opacity +
            position based on hover state.

            Frame-vs-hover sync: we hide the actual <video> behind a spinner
            until the browser confirms the seek landed near the hover target.
            Without this, the popup would show whatever frame was last
            decoded — typically 0:00 on first hover. */}
        {videoUrl && (() => {
          const previewW = 160;
          const previewH = 90;
          let left = 0;
          if (hover) {
            const half = previewW / 2;
            left = Math.max(half, Math.min(hover.barWidth - half, hover.xPx));
          }
          const visible = !!hover && durationMs > 0;
          // 350ms tolerance: browsers snap to the nearest keyframe when
          // seeking, so the seeked time can lag the request by a chunk.
          const frameMatchesHover = visible && seekedAtMs != null && Math.abs(seekedAtMs - hover!.ms) < 350;
          return (
            <div
              className="absolute pointer-events-none"
              style={{
                // When idle, park it at left=0 (off to the side after the
                // -50% transform) with opacity 0. The video element stays
                // mounted so the browser keeps it decoding-eligible.
                left: visible ? left : 0,
                bottom: '24px',
                transform: 'translateX(-50%)',
                zIndex: 20,
                opacity: visible ? 1 : 0,
                transition: visible ? 'opacity 80ms ease-out' : 'none',
              }}
            >
              <div
                className="rounded-md overflow-hidden relative"
                style={{
                  background: '#000',
                  border: '1px solid rgba(255,255,255,0.18)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  width: previewW,
                  height: previewH,
                }}
              >
                <video
                  ref={previewVideoRef}
                  src={videoUrl}
                  muted
                  playsInline
                  preload="auto"
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    objectFit: 'cover',
                    // Hide the video's pixels until the seek catches up so
                    // we never flash a stale frame from a previous hover.
                    opacity: frameMatchesHover ? 1 : 0,
                    transition: 'opacity 60ms linear',
                  }}
                />
                {/* Loading spinner shown while the seek is in flight. */}
                {!frameMatchesHover && visible && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div
                      className="w-6 h-6 rounded-full border-2 border-t-transparent"
                      style={{
                        borderColor: 'rgba(167,139,250,0.8)',
                        borderTopColor: 'transparent',
                        animation: 'reviewPreviewSpin 0.8s linear infinite',
                      }}
                    />
                  </div>
                )}
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
                {hover ? formatTime(hover.ms) : ''}
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

      <style jsx>{`
        @keyframes reviewPreviewSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
