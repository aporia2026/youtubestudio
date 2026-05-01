'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type FollowMode = 'plain' | 'teleprompter';

interface ScriptFollowProps {
  /** Section script. Visual cues like [VISUAL CUE: …] are stripped before display. */
  scriptText: string;
  /** Current playback position in ms — drives the highlighted word in teleprompter mode. */
  currentMs: number;
  /** Total audio duration in ms — used to time the words proportionally. */
  durationMs: number;
  /** Click a word → seek the player to that word's estimated timestamp. */
  onSeek?: (ms: number) => void;
}

/**
 * Display the section's script alongside the take audio so the owner can
 * verify the narrator hit every word. Two modes:
 *   - **plain**: just shows the text. No interaction.
 *   - **teleprompter**: words are spread evenly across the audio's duration
 *     and the active word is highlighted + scrolled into view as playback
 *     progresses. Click a word → seek the player. Best-effort sync; without
 *     ASR alignment this is a constant-rate approximation, which is correct
 *     when the narrator's pace is consistent and useful for spotting drift
 *     when it's not.
 *
 * Production cues (`[VISUAL CUE: …]`, `[B-ROLL …]`, etc.) are stripped before
 * tokenising — the narrator never reads those, so highlighting them would
 * desync the rest of the script.
 */
export function ScriptFollow({ scriptText, currentMs, durationMs, onSeek }: ScriptFollowProps) {
  const [mode, setMode] = useState<FollowMode>('teleprompter');
  const containerRef = useRef<HTMLDivElement>(null);

  // Strip production cues that aren't meant to be spoken.
  const spokenText = useMemo(() => {
    return scriptText.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
  }, [scriptText]);

  // Tokenise into displayable words. We keep the original word + a
  // "speakable" form (lowercased, punctuation stripped) only conceptually;
  // for the constant-rate model the word index is all that matters.
  const words = useMemo(() => spokenText.split(/\s+/).filter(Boolean), [spokenText]);

  // Index of the currently-active word. With duration D and N words, word i
  // owns the interval [i/N * D, (i+1)/N * D). When duration is unknown we
  // can't highlight anything yet, so return -1.
  const activeIdx = useMemo(() => {
    if (mode !== 'teleprompter') return -1;
    if (!durationMs || durationMs <= 0 || words.length === 0) return -1;
    const idx = Math.floor((currentMs / durationMs) * words.length);
    return Math.max(0, Math.min(words.length - 1, idx));
  }, [mode, currentMs, durationMs, words.length]);

  // Auto-scroll the active word into view in teleprompter mode. We aim for a
  // gentle "third from top" position (vs centre) so the reader can see what's
  // coming next.
  useEffect(() => {
    if (mode !== 'teleprompter') return;
    if (activeIdx < 0) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLSpanElement>(`[data-word="${activeIdx}"]`);
    if (!el) return;

    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const targetTop = cRect.top + cRect.height / 3;
    const delta = eRect.top - targetTop;
    // Only scroll when the word has drifted far enough off-target — avoids
    // jitter on every audioprocess tick.
    if (Math.abs(delta) > 8) {
      container.scrollBy({ top: delta, behavior: 'smooth' });
    }
  }, [activeIdx, mode]);

  function handleWordClick(i: number) {
    if (!onSeek || !durationMs || words.length === 0) return;
    const ms = Math.round((i / words.length) * durationMs);
    onSeek(ms);
  }

  if (!spokenText) {
    return (
      <div className="rounded-lg p-3 text-xs italic text-center" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
        No spoken text in this section.
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Script
        </span>
        <div className="flex gap-1">
          {(['plain', 'teleprompter'] as FollowMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="text-[10px] px-2 py-0.5 rounded capitalize transition-colors cursor-pointer"
              style={{
                background: mode === m ? 'rgba(124,58,237,0.18)' : 'transparent',
                color: mode === m ? '#a78bfa' : 'var(--text-muted)',
                border: `1px solid ${mode === m ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
              }}
              title={m === 'plain' ? 'Show the script as static text' : 'Highlight each word as the audio plays'}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={containerRef}
        className="px-3 py-3 max-h-48 overflow-y-auto leading-relaxed text-sm"
        style={{ color: 'var(--text-secondary)', fontFamily: 'Georgia, serif', lineHeight: 1.7 }}
      >
        {mode === 'plain' ? (
          <p className="whitespace-pre-wrap">{spokenText}</p>
        ) : (
          <p className="whitespace-pre-wrap">
            {words.map((w, i) => {
              const isActive = i === activeIdx;
              const isPast = i < activeIdx;
              return (
                <span
                  key={i}
                  data-word={i}
                  onClick={() => handleWordClick(i)}
                  className="cursor-pointer transition-colors"
                  style={{
                    background: isActive ? 'rgba(124,58,237,0.28)' : 'transparent',
                    color: isActive ? '#fff' : isPast ? 'var(--text-muted)' : 'var(--text-secondary)',
                    padding: isActive ? '0 2px' : '0',
                    borderRadius: 3,
                  }}
                  title={`Jump to "${w}"`}
                >
                  {w}
                  {i < words.length - 1 ? ' ' : ''}
                </span>
              );
            })}
          </p>
        )}
      </div>
    </div>
  );
}
