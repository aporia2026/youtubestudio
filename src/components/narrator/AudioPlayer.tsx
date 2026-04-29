'use client';

import { useRef, useState, useEffect } from 'react';

interface AudioPlayerProps {
  src: string;
  label?: string;
  compact?: boolean;
}

export function AudioPlayer({ src, label, compact }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
  }, [src]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); }
    else { a.pause(); setPlaying(false); }
  }

  function formatTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  return (
    <div className={`flex items-center gap-2 ${compact ? '' : 'p-2 rounded-lg'}`} style={compact ? {} : { background: 'var(--bg-primary)' }}>
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={() => { if (audioRef.current) setDuration(audioRef.current.duration); }}
        onTimeUpdate={() => { if (audioRef.current) setCurrentTime(audioRef.current.currentTime); }}
        onEnded={() => setPlaying(false)}
      />
      <button onClick={toggle} className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors" style={{ background: 'rgba(124,58,237,0.2)' }}>
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#a78bfa"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#a78bfa"><polygon points="5 3 19 12 5 21 5 3" /></svg>
        )}
      </button>
      {label && <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{label}</span>}
      {/* Progress bar */}
      <div className="flex-1 h-1 rounded-full cursor-pointer" style={{ background: 'rgba(255,255,255,0.1)' }}
        onClick={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          if (audioRef.current) audioRef.current.currentTime = pct * duration;
        }}
      >
        <div className="h-full rounded-full" style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, background: '#7c3aed' }} />
      </div>
      <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
        {formatTime(currentTime)}/{formatTime(duration)}
      </span>
    </div>
  );
}
