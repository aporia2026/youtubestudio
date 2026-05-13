'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import type { ReviewComment } from './ReviewPage';

/** A prior-version comment ghost-rendered on this version's timeline so the
 *  reviewer can spot v1 feedback while watching v2. Computed in ReviewPage from
 *  the all-versions comment payload. */
export interface PriorComment {
  id: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  color: string;
  versionNumber: number;
  /** Whether the editor posted a fix-note for this on the active version. */
  status: 'fixed' | 'resolved' | 'open';
  authorName: string;
  text: string;
  hasDrawing: boolean;
}

interface ReviewTimelineProps {
  currentTimeMs: number;
  durationMs: number;
  comments: ReviewComment[];
  onSeek: (ms: number) => void;
  /** Fired once when the user starts dragging the scrubber. The parent uses
   *  this to pause playback during drag so seek thrash doesn't fight with
   *  the decode loop. */
  onSeekStart?: () => void;
  /** Fired once when the user releases (or leaves) the drag. Parent resumes
   *  playback here if it had been playing. */
  onSeekEnd?: () => void;
  /** Fired when the user clicks a comment marker — bubbles up to the panel
   *  so it can scroll the comment into view + highlight it. */
  onCommentMarkerClick?: (commentId: string) => void;
  /** Fired when the user clicks a prior-version ghost marker. Same idea as
   *  above but for v(N-1) comments shown above the bar. */
  onPriorMarkerClick?: (commentId: string) => void;
  /** Previous-version comments to render as small dashed ghost markers
   *  ABOVE the bar. Skip entirely when empty. */
  priorComments?: PriorComment[];
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

export function ReviewTimeline({
  currentTimeMs, durationMs, comments, onSeek, onSeekStart, onSeekEnd,
  onCommentMarkerClick, onPriorMarkerClick, priorComments, videoUrl, bufferedPct,
}: ReviewTimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // Drag scrubbing. The bar listens to mousedown; once held, window-level
  // mousemove/mouseup take over so the user can drag the cursor off the bar
  // and the seek continues to track. Touch equivalents wire up too.
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  // Hover-preview <video> is lazy-mounted on first hover. Mounting it eagerly
  // (with preload="auto") starts a second R2 byte-range stream that steals
  // bandwidth from the main player, which is the biggest single contributor
  // to slow first-frame on this screen. Once mounted, we keep it mounted so
  // re-hovers are instant.
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const [previewMounted, setPreviewMounted] = useState(false);
  const [hover, setHover] = useState<{ ms: number; xPx: number; barWidth: number } | null>(null);
  const [seekedAtMs, setSeekedAtMs] = useState<number | null>(null);

  // Set currentTime on the preview as soon as the hover changes. We
  // deliberately do NOT gate on readyState — browsers tolerate currentTime=
  // before metadata loads and queue the seek.
  useEffect(() => {
    if (!hover || !previewMounted) return;
    const v = previewVideoRef.current;
    if (!v) return;
    const t = hover.ms / 1000;
    if (!Number.isFinite(t)) return;
    try { v.currentTime = t; } catch {}
  }, [hover, previewMounted]);

  // Track when each seek actually completes. Used to keep the popup hidden
  // until the displayed frame matches what the cursor is hovering over —
  // without this we'd show whatever frame was last decoded (typically 0:00).
  useEffect(() => {
    if (!previewMounted) return;
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
  }, [videoUrl, previewMounted]);

  // Translate a clientX (relative to the bar) into a millisecond timestamp,
  // clamped to [0, durationMs]. Returns null when the bar isn't laid out yet.
  const clientXToMs = useCallback((clientX: number): number | null => {
    const bar = barRef.current;
    if (!bar || !durationMs) return null;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * durationMs);
  }, [durationMs]);

  // Mouse-drag chain. The mousedown handler is on the bar element; once
  // armed, we attach mousemove + mouseup at the window level so the drag
  // survives the cursor leaving the bar.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const ms = clientXToMs(e.clientX);
      if (ms != null) {
        onSeek(ms);
        // Also feed the preview popup so the user gets a frame readout
        // while they drag.
        const bar = barRef.current;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          setHover({ ms, xPx: e.clientX - rect.left, barWidth: rect.width });
        }
      }
    }
    function onUp() {
      setDragging(false);
      onSeekEnd?.();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, clientXToMs, onSeek, onSeekEnd]);

  // Touch-drag chain — same idea but for iPad / touch laptops.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      const ms = clientXToMs(t.clientX);
      if (ms != null) {
        onSeek(ms);
        const bar = barRef.current;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          setHover({ ms, xPx: t.clientX - rect.left, barWidth: rect.width });
        }
      }
    }
    function onEnd() {
      setDragging(false);
      onSeekEnd?.();
    }
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [dragging, clientXToMs, onSeek, onSeekEnd]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only left mouse; right/middle clicks shouldn't scrub.
    if (e.button !== 0) return;
    e.preventDefault();
    const ms = clientXToMs(e.clientX);
    if (ms == null) return;
    onSeekStart?.();
    onSeek(ms);
    setDragging(true);
    // Make sure the preview popup appears immediately when drag starts.
    const bar = barRef.current;
    if (bar) {
      const rect = bar.getBoundingClientRect();
      setHover({ ms, xPx: e.clientX - rect.left, barWidth: rect.width });
    }
    if (!previewMounted) setPreviewMounted(true);
  }, [clientXToMs, onSeek, onSeekStart, previewMounted]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const ms = clientXToMs(t.clientX);
    if (ms == null) return;
    onSeekStart?.();
    onSeek(ms);
    setDragging(true);
  }, [clientXToMs, onSeek, onSeekStart]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // During an active drag the window-level listener handles movement; the
    // hover popup will be kept in sync there.
    if (dragging) return;
    const bar = barRef.current;
    if (!bar || !durationMs) return;
    const rect = bar.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, xPx / rect.width));
    setHover({ ms: Math.round(pct * durationMs), xPx, barWidth: rect.width });
    if (!previewMounted) setPreviewMounted(true);
  }, [dragging, durationMs, previewMounted]);

  const handleMouseEnter = useCallback(() => setHovering(true), []);
  const handleMouseLeave = useCallback(() => {
    setHovering(false);
    // Only clear the hover popup when we're NOT mid-drag — the drag chain
    // owns the popup at that point.
    if (!dragging) setHover(null);
  }, [dragging]);

  const progress = durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0;

  // Top-level (non-reply) comments on the current version.
  const topLevel = comments.filter(c => !c.parent_id);
  const ranges = topLevel
    .filter(c => c.end_timestamp_ms != null && c.end_timestamp_ms > c.timestamp_ms)
    .map((c, i) => ({
      id: c.id,
      startPct: durationMs > 0 ? (c.timestamp_ms / durationMs) * 100 : 0,
      endPct: durationMs > 0 ? (c.end_timestamp_ms! / durationMs) * 100 : 0,
      color: c.author_color,
      resolved: c.resolved,
      lane: i % 3,
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

  // Prior-version markers — rendered above the bar in their own row so they
  // never compete with the current-version markers or the scrubber's hit
  // area. Skipped entirely when empty.
  const priors = (priorComments ?? []).map(p => ({
    ...p,
    pct: durationMs > 0 ? (p.timestamp_ms / durationMs) * 100 : 0,
  }));

  // Bar appearance — grows on hover or while dragging so the scrubber is
  // easy to see and easy to hit, but doesn't dominate the layout the rest
  // of the time. Idle is intentionally a touch thicker than YouTube (3px is
  // too thin against our dark background).
  const active = hovering || dragging;
  const barHeight = active ? 10 : 4;
  const thumbSize = active ? 14 : 0;

  return (
    <div className="px-4 py-3 shrink-0" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
      {/* Time display */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(currentTimeMs)}</span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(durationMs)}</span>
      </div>

      {/* Prior-version ghost markers row — only when there are any.
          Sits above the scrub bar so the user can spot v(N-1) feedback at a
          glance without those markers fighting for the scrubber's hit area. */}
      {priors.length > 0 && (
        <div className="relative h-3 mb-1" title="Comments from previous versions">
          {priors.map(p => {
            const isOpen = p.status === 'open';
            return (
              <button
                key={p.id}
                onClick={() => { onSeek(p.timestamp_ms); onPriorMarkerClick?.(p.id); }}
                className="absolute top-1/2 -translate-y-1/2 transition-transform hover:scale-150 cursor-pointer"
                style={{ left: `${p.pct}%`, transform: 'translate(-50%, -50%)' }}
                title={`v${p.versionNumber} · ${p.authorName} · ${p.status === 'fixed' ? 'Fixed' : p.status === 'resolved' ? 'Resolved' : 'Still open'} — ${p.text.slice(0, 60)}${p.text.length > 60 ? '…' : ''}`}
              >
                <span
                  className="block rounded-full"
                  style={{
                    width: 7,
                    height: 7,
                    background: isOpen ? p.color : 'transparent',
                    border: isOpen ? `1px solid ${p.color}` : `1px dashed ${p.color}`,
                    opacity: isOpen ? 0.85 : 0.5,
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Range comment bars — sit just above the scrub bar so they don't
          fight for click events with the bar itself. Click jumps to start. */}
      {ranges.length > 0 && (
        <div className="relative h-3 mb-1">
          {ranges.map(r => (
            <button
              key={r.id}
              onClick={() => { onSeek(r.timestampMs); onCommentMarkerClick?.(r.id); }}
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

      {/* Scrub bar wrapper — a fixed 20px tall hit area regardless of how
          thick the visible bar is. This is the key reason the scrubber was
          hard to click before: the bar itself was 8px and the wrapper had no
          padding. */}
      <div
        className="relative cursor-pointer group select-none"
        style={{ height: 20 }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Visible bar — vertically centered inside the 20px hit area. */}
        <div
          ref={barRef}
          className="absolute left-0 right-0 rounded-full"
          style={{
            top: `${(20 - barHeight) / 2}px`,
            height: barHeight,
            background: 'rgba(255,255,255,0.12)',
            transition: 'height 80ms ease-out, top 80ms ease-out',
          }}
        >
          {/* Buffered fill — sits beneath the progress gradient so the viewer
              sees how much of the video is ready ahead of the playhead. */}
          {typeof bufferedPct === 'number' && bufferedPct > 0 && (
            <div
              className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
              style={{ width: `${Math.min(100, bufferedPct)}%`, background: 'rgba(255,255,255,0.22)' }}
            />
          )}

          {/* Progress fill */}
          <div
            className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
            style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
          />

          {/* Playhead thumb — hidden when idle, grows on hover/drag so the
              user has a clear grab point. pointer-events: none so the
              wrapper's mousedown still gets the event when clicking AT the
              thumb's exact position. */}
          {thumbSize > 0 && (
            <div
              className="absolute top-1/2 rounded-full bg-white shadow-lg pointer-events-none"
              style={{
                left: `${progress}%`,
                width: thumbSize,
                height: thumbSize,
                transform: 'translate(-50%, -50%)',
                boxShadow: '0 0 0 2px #7c3aed, 0 2px 6px rgba(0,0,0,0.4)',
                transition: 'width 80ms ease-out, height 80ms ease-out',
              }}
            />
          )}

          {/* Point markers for current-version comments — rendered inside
              the visible bar so they vertically follow the bar's growth.
              pointer-events: auto so they're independently clickable. */}
          {points.map(marker => (
            <button
              key={marker.id}
              onMouseDown={e => e.stopPropagation()}
              onTouchStart={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onSeek(marker.timestampMs); onCommentMarkerClick?.(marker.id); }}
              className="absolute top-1/2 -translate-y-1/2 transition-transform hover:scale-150 cursor-pointer"
              style={{ left: `${marker.pct}%`, transform: 'translate(-50%, -50%)', pointerEvents: 'auto' }}
              title={`Comment at ${formatTime(marker.timestampMs)} — click to jump`}
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

        {/* Hover preview popup. The <video> is mounted lazily on first
            hover (or first drag) — see `previewMounted`. Eagerly mounting
            it kicks off a second R2 stream that steals bandwidth from the
            main player.

            Frame-vs-hover sync: we hide the actual <video> behind a spinner
            until the browser confirms the seek landed near the hover target.
            Without this, the popup would show whatever frame was last
            decoded — typically 0:00 on first hover. */}
        {videoUrl && previewMounted && (() => {
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
                  // Only fetch metadata for the preview — we'll seek into
                  // ranges as needed. preload="auto" here was the biggest
                  // single bandwidth thief.
                  preload="metadata"
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    objectFit: 'cover',
                    opacity: frameMatchesHover ? 1 : 0,
                    transition: 'opacity 60ms linear',
                  }}
                />
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
      </div>

      <style jsx>{`
        @keyframes reviewPreviewSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
