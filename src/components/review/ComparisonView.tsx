'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { VideoSyncManager } from './VideoSyncManager';
import type { ReviewVersion } from './ReviewPage';

interface ComparisonViewProps {
  mode: 'side-by-side' | 'onion-skin' | 'swipe';
  version1: ReviewVersion;
  version2: ReviewVersion;
  onTimeUpdate: (ms: number) => void;
}

export function ComparisonView({ mode, version1, version2, onTimeUpdate }: ComparisonViewProps) {
  const v1Ref = useRef<HTMLVideoElement>(null);
  const v2Ref = useRef<HTMLVideoElement>(null);
  const syncRef = useRef<VideoSyncManager | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [opacity, setOpacity] = useState(0.5);
  const [swipePos, setSwipePos] = useState(50);
  const [dragging, setDragging] = useState(false);

  // Setup sync manager
  useEffect(() => {
    const v1 = v1Ref.current;
    const v2 = v2Ref.current;
    if (!v1 || !v2) return;
    syncRef.current = new VideoSyncManager(v1, v2);
    return () => { syncRef.current?.dispose(); syncRef.current = null; };
  }, [version1.id, version2.id]);

  const togglePlay = useCallback(() => {
    const v = v1Ref.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  function handleTimeUpdate() {
    if (v1Ref.current) onTimeUpdate(Math.round(v1Ref.current.currentTime * 1000));
  }

  // Swipe drag handler
  const handleSwipeMove = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    setSwipePos(pct);
  }, [dragging]);

  useEffect(() => {
    if (!dragging) return;
    const handleUp = () => setDragging(false);
    const handleMove = (e: MouseEvent) => handleSwipeMove(e);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('mousemove', handleMove);
    return () => {
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('mousemove', handleMove);
    };
  }, [dragging, handleSwipeMove]);

  if (mode === 'side-by-side') {
    return (
      <div className="flex-1 flex flex-col bg-black">
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 relative flex items-center justify-center">
            <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-medium text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
              v{version1.version_number}
            </span>
            <video ref={v1Ref} src={version1.video_url || undefined} onTimeUpdate={handleTimeUpdate} onClick={togglePlay} className="max-w-full max-h-full" playsInline />
          </div>
          <div className="w-px shrink-0" style={{ background: 'rgba(255,255,255,0.2)' }} />
          <div className="flex-1 relative flex items-center justify-center">
            <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-medium text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
              v{version2.version_number}
            </span>
            <video ref={v2Ref} src={version2.video_url || undefined} onClick={togglePlay} className="max-w-full max-h-full" playsInline muted />
          </div>
        </div>
        <ComparisonControls playing={playing} onTogglePlay={togglePlay} />
      </div>
    );
  }

  if (mode === 'onion-skin') {
    return (
      <div className="flex-1 flex flex-col bg-black">
        <div className="flex-1 relative flex items-center justify-center min-h-0">
          <video ref={v1Ref} src={version1.video_url || undefined} onTimeUpdate={handleTimeUpdate} onClick={togglePlay} className="max-w-full max-h-full" playsInline />
          <video
            ref={v2Ref}
            src={version2.video_url || undefined}
            onClick={togglePlay}
            className="absolute max-w-full max-h-full"
            style={{ opacity }}
            playsInline muted
          />
          <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
            v{version1.version_number}
          </span>
          <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-xs text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
            v{version2.version_number}
          </span>
        </div>
        <div className="flex items-center gap-3 px-4 py-2" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
          <ComparisonControls playing={playing} onTogglePlay={togglePlay} />
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>v{version1.version_number}</span>
            <input type="range" min="0" max="1" step="0.01" value={opacity} onChange={e => setOpacity(parseFloat(e.target.value))} className="w-24 accent-purple-500" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>v{version2.version_number}</span>
          </div>
        </div>
      </div>
    );
  }

  // Swipe mode
  return (
    <div className="flex-1 flex flex-col bg-black">
      <div ref={containerRef} className="flex-1 relative flex items-center justify-center min-h-0 select-none">
        <video ref={v1Ref} src={version1.video_url || undefined} onTimeUpdate={handleTimeUpdate} onClick={togglePlay} className="max-w-full max-h-full" playsInline />
        <video
          ref={v2Ref}
          src={version2.video_url || undefined}
          onClick={togglePlay}
          className="absolute max-w-full max-h-full"
          style={{ clipPath: `inset(0 ${100 - swipePos}% 0 0)` }}
          playsInline muted
        />
        {/* Divider line */}
        <div
          className="absolute top-0 bottom-0 w-0.5 cursor-col-resize z-10"
          style={{ left: `${swipePos}%`, background: 'white' }}
          onMouseDown={() => setDragging(true)}
        >
          {/* Handle */}
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-6 h-6 rounded-full border-2 border-white flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M8 18l-6-6 6-6M16 6l6 6-6 6" /></svg>
          </div>
        </div>
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
          v{version2.version_number}
        </span>
        <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-xs text-white z-10" style={{ background: 'rgba(0,0,0,0.6)' }}>
          v{version1.version_number}
        </span>
      </div>
      <ComparisonControls playing={playing} onTogglePlay={togglePlay} />
    </div>
  );
}

function ComparisonControls({ playing, onTogglePlay }: { playing: boolean; onTogglePlay: () => void }) {
  return (
    <div className="flex items-center px-4 py-2" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
      <button onClick={onTogglePlay} className="text-white hover:text-purple-400 transition-colors">
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
        )}
      </button>
    </div>
  );
}
