'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

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

type ViewMode = 'styled' | 'plain';

/**
 * Strip [VISUAL CUE: ...] / [SFX: ...] style production markers from a
 * narration line. The section divider already shows production context;
 * leaving these inline just makes the narrator read them out loud.
 */
function stripCues(text: string): string {
  return text.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

export function TeleprompterMode({ sections, wpm, onClose }: TeleprompterModeProps) {
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(wpm);
  const [fontSize, setFontSize] = useState(36);
  const [viewMode, setViewMode] = useState<ViewMode>('styled');

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  // Sub-pixel scroll position. The browser truncates `element.scrollTop`
  // to an integer on every assignment, so adding a fractional delta each
  // frame (typical at <150 wpm on long scripts) silently rounds to zero
  // and the page never moves. We accumulate the real value here and
  // assign Math.floor() to the DOM, which lets even tiny per-frame
  // increments add up over time.
  const scrollPosRef = useRef<number>(0);

  // Sections that actually have something for the narrator to read. Empty
  // sections (label/divider only, or whose body is just production cues)
  // pollute the teleprompter with awkward gaps — drop them up front.
  const visibleSections = useMemo(
    () => sections.filter(s => stripCues(s.script_text).length > 0),
    [sections],
  );

  const totalWords = visibleSections.reduce(
    (acc, s) => acc + stripCues(s.script_text).split(/\s+/).filter(Boolean).length,
    0,
  );
  const totalDurationMs = totalWords > 0 ? (totalWords / speed) * 60 * 1000 : 0;

  const startScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollHeight = container.scrollHeight - container.clientHeight;
    if (scrollHeight <= 0 || totalDurationMs <= 0) {
      // Nothing to scroll through — bail out cleanly.
      setScrolling(false);
      return;
    }

    const pixelsPerMs = scrollHeight / totalDurationMs;
    lastTimeRef.current = performance.now();
    // Sync our float accumulator with whatever the user might have
    // manually scrolled to (e.g. they dragged partway, then hit play).
    scrollPosRef.current = container.scrollTop;

    function step(now: number) {
      const c = containerRef.current;
      if (!c) { rafRef.current = null; return; }
      const elapsed = now - lastTimeRef.current;
      lastTimeRef.current = now;
      scrollPosRef.current += pixelsPerMs * elapsed;
      // Floor so we always assign an integer that the browser won't
      // round on us. Even sub-pixel deltas now accumulate.
      c.scrollTop = Math.floor(scrollPosRef.current);
      if (c.scrollTop >= c.scrollHeight - c.clientHeight - 1) {
        setScrolling(false);
        rafRef.current = null;
        return;
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

  // Restart scroll when speed or view mode changes (layout differs in plain
  // mode so the total scroll distance is different).
  useEffect(() => {
    if (scrolling) {
      stopScroll();
      startScroll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, viewMode]);

  // Cleanup on unmount.
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === 'Space') { e.preventDefault(); toggleScroll(); }
      if (e.code === 'Escape') onClose();
      if (e.code === 'ArrowUp') setSpeed(s => Math.min(250, s + 10));
      if (e.code === 'ArrowDown') setSpeed(s => Math.max(80, s - 10));
      if (e.code === 'Equal' || e.code === 'NumpadAdd') setFontSize(f => Math.min(72, f + 4));
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') setFontSize(f => Math.max(20, f - 4));
      if (e.code === 'KeyV') setViewMode(m => m === 'styled' ? 'plain' : 'styled');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleScroll, onClose]);

  // Persist prefs
  useEffect(() => {
    localStorage.setItem('teleprompter_prefs', JSON.stringify({ speed, fontSize, viewMode }));
  }, [speed, fontSize, viewMode]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('teleprompter_prefs');
      if (saved) {
        const { speed: s, fontSize: f, viewMode: v } = JSON.parse(saved);
        if (s) setSpeed(s);
        if (f) setFontSize(f);
        if (v === 'plain' || v === 'styled') setViewMode(v);
      }
    } catch {}
  }, []);

  // Pre-compute cleaned text per section once so render doesn't redo it on
  // every frame (font size + scroll changes re-render this component).
  const renderedSections = useMemo(
    () => visibleSections.map(s => ({ ...s, _clean: stripCues(s.script_text) })),
    [visibleSections],
  );

  return (
    <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: '#050508' }}>
      {/* Script content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-12 py-20"
        style={{ scrollBehavior: 'auto' }}
      >
        <div className="max-w-3xl mx-auto">
          {viewMode === 'plain' ? (
            // Plain mode: just the script text run together as flowing
            // paragraphs. No section dividers, no director-notes box, no
            // serif. Closer to reading from a Word doc — what some
            // narrators prefer.
            <p
              className="leading-relaxed whitespace-pre-wrap"
              style={{ fontSize, color: '#e2e8f0', lineHeight: 1.7 }}
            >
              {renderedSections.map(s => s._clean).join('\n\n')}
            </p>
          ) : (
            renderedSections.map(section => (
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
                  {section._clean}
                </p>
              </div>
            ))
          )}
          {/* End marker */}
          <div className="text-center py-20">
            <span className="text-lg" style={{ color: 'rgba(124,58,237,0.5)' }}>- END -</span>
          </div>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-center gap-6 px-6 py-4 shrink-0 flex-wrap" style={{ background: 'rgba(0,0,0,0.9)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <button onClick={toggleScroll} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: scrolling ? 'rgba(239,68,68,0.2)' : 'rgba(124,58,237,0.2)' }}>
          {scrolling ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#ef4444"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#a78bfa"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          )}
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Speed</span>
          <button onClick={() => setSpeed(s => Math.max(80, s - 10))} className="text-white px-1">-</button>
          <span className="text-xs font-mono w-14 text-center" style={{ color: '#a78bfa' }}>{speed} wpm</span>
          <button onClick={() => setSpeed(s => Math.min(250, s + 10))} className="text-white px-1">+</button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Font</span>
          <button onClick={() => setFontSize(f => Math.max(20, f - 4))} className="text-white px-1">-</button>
          <span className="text-xs font-mono w-8 text-center" style={{ color: '#a78bfa' }}>{fontSize}</span>
          <button onClick={() => setFontSize(f => Math.min(72, f + 4))} className="text-white px-1">+</button>
        </div>

        {/* View mode toggle — Styled (with section dividers + director
            notes) vs Plain (just the script text). */}
        <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['styled', 'plain'] as ViewMode[]).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className="px-2.5 py-1 rounded text-[11px] capitalize transition-colors"
              style={{
                background: viewMode === m ? 'rgba(124,58,237,0.25)' : 'transparent',
                color: viewMode === m ? '#a78bfa' : 'var(--text-muted)',
              }}
              title={m === 'plain' ? 'Plain script — no dividers or director notes' : 'Styled with section dividers + director notes'}
            >
              {m}
            </button>
          ))}
        </div>

        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}>
          Exit (Esc)
        </button>
      </div>
    </div>
  );
}
