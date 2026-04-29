'use client';

import { useRef, useCallback } from 'react';
import type { ReviewComment } from './ReviewPage';

interface ReviewTimelineProps {
  currentTimeMs: number;
  durationMs: number;
  comments: ReviewComment[];
  onSeek: (ms: number) => void;
}

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ReviewTimeline({ currentTimeMs, durationMs, comments, onSeek }: ReviewTimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar || !durationMs) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(Math.round(pct * durationMs));
  }, [durationMs, onSeek]);

  const progress = durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0;

  // Deduplicate markers that are very close together
  const markers = comments.map(c => ({
    id: c.id,
    pct: durationMs > 0 ? (c.timestamp_ms / durationMs) * 100 : 0,
    color: c.author_color,
    hasDrawing: !!c.drawing_data,
    resolved: c.resolved,
  }));

  return (
    <div className="px-4 py-3 shrink-0" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
      {/* Time display */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(currentTimeMs)}</span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(durationMs)}</span>
      </div>

      {/* Progress bar */}
      <div
        ref={barRef}
        onClick={handleClick}
        className="relative h-2 rounded-full cursor-pointer group"
        style={{ background: 'rgba(255,255,255,0.1)' }}
      >
        {/* Progress fill */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
        />

        {/* Playhead */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow-lg"
          style={{ left: `${progress}%`, transform: `translate(-50%, -50%)`, background: '#7c3aed' }}
        />

        {/* Comment markers */}
        {markers.map(marker => (
          <button
            key={marker.id}
            onClick={e => { e.stopPropagation(); onSeek(Math.round((marker.pct / 100) * durationMs)); }}
            className="absolute top-1/2 -translate-y-1/2 transition-transform hover:scale-150"
            style={{ left: `${marker.pct}%`, transform: 'translate(-50%, -50%)' }}
            title={`Comment at ${formatTime(Math.round((marker.pct / 100) * durationMs))}`}
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
