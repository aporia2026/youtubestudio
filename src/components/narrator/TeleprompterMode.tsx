'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface Section {
  section_number: number;
  label: string | null;
  script_text: string;
  director_notes: string | null;
  estimated_duration_seconds: number | null;
}

interface TeleprompterModeProps {
  sections: Section[];
  wpm: number;
  onClose: () => void;
}

export function TeleprompterMode({ sections, wpm, onClose }: TeleprompterModeProps) {
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(wpm);
  const [fontSize, setFontSize] = useState(36);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Calculate total word count for scroll speed
  const totalWords = sections.reduce((acc, s) => acc + s.script_text.split(/\s+/).length, 0);
  const totalDurationMs = (totalWords / speed) * 60 * 1000;

  const startScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollHeight = container.scrollHeight - container.clientHeight;
    if (scrollHeight <= 0) return;

    const pixelsPerMs = scrollHeight / totalDurationMs;
    lastTimeRef.current = performance.now();

    function step(now: number) {
      const elapsed = now - lastTimeRef.current;
      lastTimeRef.current = now;
      if (container) {
        container.scrollTop += pixelsPerMs * elapsed;
        if (container.scrollTop >= scrollHeight) {
          setScrolling(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
  }, [totalDurationMs]);

  const stopScroll = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const toggleScroll = useCallback(() => {
    if (scrolling) {
      stopScroll();
      setScrolling(false);
    } else {
      setScrolling(true);
      startScroll();
    }
  }, [scrolling, startScroll, stopScroll]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === 'Space') { e.preventDefault(); toggleScroll(); }
      if (e.code === 'Escape') onClose();
      if (e.code === 'ArrowUp') setSpeed(s => Math.min(250, s + 10));
      if (e.code === 'ArrowDown') setSpeed(s => Math.max(80, s - 10));
      if (e.code === 'Equal' || e.code === 'NumpadAdd') setFontSize(f => Math.min(72, f + 4));
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') setFontSize(f => Math.max(20, f - 4));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleScroll, onClose]);

  // Restart scroll when speed changes
  useEffect(() => {
    if (scrolling) {
      stopScroll();
      startScroll();
    }
  }, [speed, scrolling, stopScroll, startScroll]);

  // Cleanup
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Store prefs in localStorage
  useEffect(() => {
    localStorage.setItem('teleprompter_prefs', JSON.stringify({ speed, fontSize }));
  }, [speed, fontSize]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('teleprompter_prefs');
      if (saved) {
        const { speed: s, fontSize: f } = JSON.parse(saved);
        if (s) setSpeed(s);
        if (f) setFontSize(f);
      }
    } catch {}
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: '#050508' }}>
      {/* Script content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-12 py-20"
        style={{ scrollBehavior: 'auto' }}
      >
        <div className="max-w-3xl mx-auto">
          {sections.map(section => (
            <div key={section.section_number} className="mb-12">
              {/* Section divider */}
              <div className="flex items-center gap-4 mb-6">
                <div className="h-px flex-1" style={{ background: 'rgba(124,58,237,0.3)' }} />
                <span className="text-sm font-medium px-3 py-1 rounded-full" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
                  {section.label || `Section ${section.section_number}`}
                  {section.estimated_duration_seconds && <span className="ml-2 opacity-60">~{section.estimated_duration_seconds}s</span>}
                </span>
                <div className="h-px flex-1" style={{ background: 'rgba(124,58,237,0.3)' }} />
              </div>

              {/* Director notes */}
              {section.director_notes && (
                <p className="text-sm mb-4 italic" style={{ color: '#06b6d4', fontSize: Math.max(14, fontSize * 0.4) }}>
                  {section.director_notes}
                </p>
              )}

              {/* Script text */}
              <p
                className="leading-relaxed whitespace-pre-wrap"
                style={{ fontSize, color: '#e2e8f0', fontFamily: 'Georgia, serif', lineHeight: 1.8 }}
              >
                {section.script_text.replace(/\[[^\]]+\]/g, '')}
              </p>
            </div>
          ))}
          {/* End marker */}
          <div className="text-center py-20">
            <span className="text-lg" style={{ color: 'rgba(124,58,237,0.5)' }}>- END -</span>
          </div>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-center gap-6 px-6 py-4 shrink-0" style={{ background: 'rgba(0,0,0,0.9)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <button onClick={toggleScroll} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: scrolling ? 'rgba(239,68,68,0.2)' : 'rgba(124,58,237,0.2)' }}>
          {scrolling ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill={scrolling ? '#ef4444' : '#a78bfa'}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#a78bfa"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          )}
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Speed</span>
          <button onClick={() => setSpeed(s => Math.max(80, s - 10))} className="text-white px-1">-</button>
          <span className="text-xs font-mono w-12 text-center" style={{ color: '#a78bfa' }}>{speed} wpm</span>
          <button onClick={() => setSpeed(s => Math.min(250, s + 10))} className="text-white px-1">+</button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Font</span>
          <button onClick={() => setFontSize(f => Math.max(20, f - 4))} className="text-white px-1">-</button>
          <span className="text-xs font-mono w-8 text-center" style={{ color: '#a78bfa' }}>{fontSize}</span>
          <button onClick={() => setFontSize(f => Math.min(72, f + 4))} className="text-white px-1">+</button>
        </div>

        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}>
          Exit (Esc)
        </button>
      </div>
    </div>
  );
}
