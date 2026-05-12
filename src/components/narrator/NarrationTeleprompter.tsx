'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { findActiveWordIndex, sliceAlignmentToSections } from '@/lib/narrator-utils';
import type { ForcedAlignmentResponse, ForcedAlignmentWord } from '@/lib/elevenlabs';

interface NarrationTeleprompterProps {
  /** Sections in the same order they were sent to the aligner — labels render
   *  as section headers, script_text is unused (we read words from the
   *  alignment so what's highlighted is exactly what's timed). */
  sections: Array<{ label?: string | null; script_text: string }>;
  /** Raw ElevenLabs forced-alignment payload. */
  alignment: ForcedAlignmentResponse;
  /** Current playhead in ms. */
  currentMs: number;
  /** Click a word → seek the audio to that word's start. */
  onSeek: (ms: number) => void;
  /** Optional: called when the reviewer clicks the inline "💬 Comment
   *  here" chip next to the active word. Parent pauses playback and
   *  scrolls/focuses the comment input — the chip itself is purely a
   *  discovery affordance so the reviewer doesn't have to scroll to find
   *  the input. */
  onCommentHere?: () => void;
  /** Per-word loss above this threshold renders with a low-confidence
   *  underline. Default tuned conservatively — flag visibly only when
   *  the aligner is genuinely uncertain. */
  lossThreshold?: number;
}

/**
 * Word-accurate teleprompter driven by real ElevenLabs forced-alignment
 * timestamps. Replaces the `ScriptFollow` constant-rate approximation for
 * the Narration tab's full-audio review when the synced player is on.
 *
 *   - Each spoken word gets its own clickable span with the exact
 *     start/end times from the aligner.
 *   - The active word (whose [start, end] interval contains `currentMs`)
 *     is highlighted. Already-spoken words fade. Upcoming words sit at
 *     normal contrast so the reviewer can see what's coming next.
 *   - High-loss words (the aligner is uncertain whether the narrator
 *     actually said this word, or said it correctly) get a dotted
 *     underline so the reviewer's eye is drawn straight to likely
 *     misreads.
 *   - Click a word → seek. Auto-scroll mirrors ScriptFollow's behaviour:
 *     soft "third from top" target, suspended for 3s after the user
 *     scrolls manually, re-engaged via a "↻ Re-sync" chip.
 *
 * Empty word list (alignment failed mid-stream / aligner returned nothing)
 * renders the fallback message so the parent doesn't need to gate on it.
 */
export function NarrationTeleprompter({
  sections,
  alignment,
  currentMs,
  onSeek,
  onCommentHere,
  lossThreshold = 0,
}: NarrationTeleprompterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrollAtRef = useRef<number>(0);
  const [followLocked, setFollowLocked] = useState(false);

  // Slice the flat alignment into per-section word arrays. Stable across
  // currentMs changes — only re-computes when sections/alignment do.
  const perSection = useMemo(
    () => sliceAlignmentToSections(alignment, sections),
    [alignment, sections],
  );

  // Flat list of (sectionIndex, wordIndex-within-section, word) for the
  // binary search. The aligner's word timings are monotonically
  // increasing across the whole audio, so a single binary search beats
  // per-section searches when the user scrubs to an arbitrary time.
  const flat = useMemo(() => {
    const out: Array<{ sectionIdx: number; localIdx: number; word: ForcedAlignmentWord }> = [];
    for (const seg of perSection) {
      for (let i = 0; i < seg.words.length; i++) {
        out.push({ sectionIdx: seg.sectionIndex, localIdx: i, word: seg.words[i] });
      }
    }
    return out;
  }, [perSection]);

  const flatWords = useMemo(() => flat.map((e) => e.word), [flat]);

  const currentSeconds = currentMs / 1000;
  const activeFlatIdx = useMemo(
    () => findActiveWordIndex(flatWords, currentSeconds),
    [flatWords, currentSeconds],
  );

  // Auto-scroll the active word into view. Skipped when the user scrolled
  // manually within the last 3s.
  useEffect(() => {
    if (activeFlatIdx < 0) return;
    if (followLocked) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLSpanElement>(`[data-flat="${activeFlatIdx}"]`);
    if (!el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const targetTop = cRect.top + cRect.height / 3;
    const delta = eRect.top - targetTop;
    if (Math.abs(delta) > 8) {
      container.scrollBy({ top: delta, behavior: 'smooth' });
    }
  }, [activeFlatIdx, followLocked]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onUserScroll = () => {
      userScrollAtRef.current = Date.now();
      setFollowLocked(true);
    };
    container.addEventListener('wheel', onUserScroll, { passive: true });
    container.addEventListener('touchmove', onUserScroll, { passive: true });
    return () => {
      container.removeEventListener('wheel', onUserScroll);
      container.removeEventListener('touchmove', onUserScroll);
    };
  }, []);

  useEffect(() => {
    if (!followLocked) return;
    const interval = setInterval(() => {
      if (Date.now() - userScrollAtRef.current > 3000) {
        setFollowLocked(false);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [followLocked]);

  function handleWordClick(word: ForcedAlignmentWord) {
    // Pre-roll a hair so the word is heard cleanly when seeking near its
    // leading edge — the playhead lands ~80ms before the word's start.
    const targetMs = Math.max(0, Math.round(word.start * 1000) - 80);
    onSeek(targetMs);
  }

  if (flatWords.length === 0) {
    return (
      <div
        className="rounded-lg p-3 text-xs italic text-center"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
      >
        Sync data is empty. Try retrying alignment from the badge above the player.
      </div>
    );
  }

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Script · word-accurate sync
        </span>
        <div className="flex gap-1 items-center">
          {followLocked && (
            <button
              onClick={() => {
                userScrollAtRef.current = 0;
                setFollowLocked(false);
              }}
              className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer"
              style={{
                background: 'rgba(34,197,94,0.15)',
                color: '#22c55e',
                border: '1px solid rgba(34,197,94,0.3)',
              }}
              title="Re-engage auto-follow"
            >
              ↻ Re-sync
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="px-3 py-3 max-h-72 overflow-y-auto leading-relaxed text-sm"
        style={{ color: 'var(--text-secondary)', fontFamily: 'Georgia, serif', lineHeight: 1.75 }}
      >
        {perSection.map((seg, segIdx) => {
          const section = sections[seg.sectionIndex];
          if (!section || seg.words.length === 0) return null;
          return (
            <div key={seg.sectionIndex} className={segIdx > 0 ? 'mt-3' : ''}>
              {section.label && (
                <div
                  className="text-[10px] uppercase tracking-wider mb-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {section.label}
                </div>
              )}
              <p className="whitespace-pre-wrap">
                {seg.words.map((w, i) => {
                  // Recover the flat index so the active-word lookup and the
                  // scroll target agree on the same DOM node.
                  const flatIdx = flat.findIndex(
                    (f) => f.sectionIdx === seg.sectionIndex && f.localIdx === i,
                  );
                  const isActive = flatIdx === activeFlatIdx;
                  const isPast = activeFlatIdx >= 0 && flatIdx < activeFlatIdx;
                  const lowConfidence = w.loss != null && w.loss > lossThreshold;
                  return (
                    <span key={`${seg.sectionIndex}-${i}`} style={{ position: 'relative' }}>
                      <span
                        data-flat={flatIdx}
                        onClick={() => handleWordClick(w)}
                        className="cursor-pointer transition-colors"
                        style={{
                          background: isActive ? 'rgba(124,58,237,0.28)' : 'transparent',
                          color: isActive ? '#fff' : isPast ? 'var(--text-muted)' : 'var(--text-secondary)',
                          padding: isActive ? '0 2px' : '0',
                          borderRadius: 3,
                          textDecoration: lowConfidence ? 'underline dotted' : 'none',
                          textDecorationColor: lowConfidence ? 'rgba(239,68,68,0.6)' : undefined,
                          textUnderlineOffset: lowConfidence ? '3px' : undefined,
                        }}
                        title={
                          lowConfidence
                            ? `Low confidence — listen carefully. ${w.text} @ ${w.start.toFixed(2)}s`
                            : `Jump to "${w.text}" @ ${w.start.toFixed(2)}s`
                        }
                      >
                        {w.text}
                      </span>
                      {isActive && onCommentHere && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onCommentHere();
                          }}
                          className="inline-flex items-center gap-0.5 ml-1 px-1.5 py-0 rounded text-[10px] cursor-pointer transition-opacity"
                          style={{
                            background: 'rgba(124,58,237,0.18)',
                            color: '#a78bfa',
                            border: '1px solid rgba(124,58,237,0.3)',
                            verticalAlign: 'middle',
                          }}
                          title="Pause and write a comment on this word"
                        >
                          💬 Comment
                        </button>
                      )}
                      {i < seg.words.length - 1 ? ' ' : ''}
                    </span>
                  );
                })}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
