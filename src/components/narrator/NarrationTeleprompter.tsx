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
  /** Optional: called when the reviewer clicks the "Comment" button in
   *  the sticky bottom bar. Parent pauses playback and scrolls/focuses
   *  the comment input. The bar is the discovery affordance so the
   *  reviewer doesn't have to scroll down to find the comment textarea. */
  onCommentHere?: () => void;
  /** Whether the underlying audio is currently playing. Drives the
   *  hover-to-pause overlay — when true, hovering the reading area
   *  surfaces a big centred Pause button so the reviewer can stop at
   *  the exact word without aiming for the small waveform play button. */
  isPlaying?: boolean;
  /** Called when the reviewer clicks the hover Pause button. Should
   *  pause playback at the current position (no seek). */
  onPause?: () => void;
}

/**
 * Word-accurate teleprompter driven by real ElevenLabs forced-alignment
 * timestamps. Replaces the `ScriptFollow` constant-rate approximation for
 * the Narration tab's full-audio review when the synced player is on.
 *
 * Design:
 *   - Generous typography (18px / 1.9 line-height) for comfortable
 *     reading at arm's length.
 *   - The active word gets a rounded purple chip with a soft glow.
 *     Same horizontal padding on every word so the highlight moving
 *     between words doesn't cause layout shift.
 *   - Past words fade to 35% opacity; upcoming words stay full contrast
 *     so the reviewer can read ahead.
 *   - Auto-scroll keeps the active word ~40% from the top of the
 *     viewport (slightly above centre — gives the reviewer breathing
 *     room to anticipate the next line). Suspended for 3s after the
 *     reviewer scrolls manually, re-engaged via the "Re-sync" chip.
 *   - Sticky bottom bar shows the current word + a Comment button.
 *     Always visible, no layout shift, single tap to pause+comment.
 *
 * Notes:
 *   - We deliberately do NOT render per-word "low confidence"
 *     indicators. ElevenLabs' `loss` is non-zero for nearly every word
 *     so a naive threshold flags everything; a useful indicator would
 *     need a relative threshold (e.g. top 5% worst-fit). Defer until
 *     we have data on what reviewers actually want.
 *   - Click any word → seek with an 80ms pre-roll so the playhead lands
 *     just before the word's leading edge.
 */
export function NarrationTeleprompter({
  sections,
  alignment,
  currentMs,
  onSeek,
  onCommentHere,
  isPlaying = false,
  onPause,
}: NarrationTeleprompterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrollAtRef = useRef<number>(0);
  const [followLocked, setFollowLocked] = useState(false);
  const [hovered, setHovered] = useState(false);

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

  // Pre-compute a (sectionIdx, localIdx) → flatIdx map so the render
  // doesn't do an O(N) findIndex inside an O(N) inner loop. With ~2k
  // words on a 14-min file the original implementation was O(N²) per
  // render = ~4M comparisons per audioprocess tick. Lookup is now O(1).
  const flatIdxLookup = useMemo(() => {
    const map = new Map<string, number>();
    flat.forEach((entry, idx) => {
      map.set(`${entry.sectionIdx}:${entry.localIdx}`, idx);
    });
    return map;
  }, [flat]);

  const currentSeconds = currentMs / 1000;
  const activeFlatIdx = useMemo(
    () => findActiveWordIndex(flatWords, currentSeconds),
    [flatWords, currentSeconds],
  );

  // Active word's text for the sticky bottom bar. Null between words
  // (activeFlatIdx === -1, ~50ms gaps). Pure derivation — no setState
  // cascade.
  const activeWordText = useMemo(
    () =>
      activeFlatIdx >= 0 && flat[activeFlatIdx]
        ? flat[activeFlatIdx].word.text
        : null,
    [activeFlatIdx, flat],
  );

  // Auto-scroll the active word into view. Skipped when the user
  // scrolled manually within the last 3s. Target is 40% from the top so
  // the reviewer sees ~half a line above and ~five lines below the
  // active word — comfortable read-ahead.
  useEffect(() => {
    if (activeFlatIdx < 0) return;
    if (followLocked) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLSpanElement>(`[data-flat="${activeFlatIdx}"]`);
    if (!el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const targetTop = cRect.top + cRect.height * 0.4;
    const delta = eRect.top - targetTop;
    // Only scroll when the word has drifted far enough off-target — avoids
    // jitter on every audioprocess tick.
    if (Math.abs(delta) > 8) {
      container.scrollBy({ top: delta, behavior: 'smooth' });
    }
  }, [activeFlatIdx, followLocked]);

  // Watch for user-initiated scroll. Wheel + touchmove are user events;
  // our own scrollBy() doesn't fire them.
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

  // Auto-release the follow lock 3s after the last user scroll.
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
        className="rounded-xl p-6 text-sm italic text-center"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
      >
        Sync data is empty. Try retrying alignment from the badge above the player.
      </div>
    );
  }

  const showPauseOverlay = hovered && isPlaying && !!onPause;

  return (
    <div
      className="rounded-xl overflow-hidden relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:
          'linear-gradient(180deg, rgba(124,58,237,0.05) 0%, rgba(124,58,237,0) 200px), var(--bg-primary)',
        border: '1px solid var(--border)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset',
      }}
    >
      {/* Header strip */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-baseline gap-2">
          <span
            className="text-[10px] uppercase tracking-[0.15em] font-semibold"
            style={{ color: 'var(--text-muted)' }}
          >
            Script
          </span>
          <span className="text-[10px]" style={{ color: 'rgba(167,139,250,0.55)' }}>
            · word-accurate sync
          </span>
        </div>
        {followLocked && (
          <button
            onClick={() => {
              userScrollAtRef.current = 0;
              setFollowLocked(false);
            }}
            className="text-[10px] px-2 py-1 rounded-md transition-colors cursor-pointer"
            style={{
              background: 'rgba(34,197,94,0.12)',
              color: '#22c55e',
              border: '1px solid rgba(34,197,94,0.3)',
            }}
            title="Re-engage auto-follow"
          >
            ↻ Re-sync
          </button>
        )}
      </div>

      {/* Reading body */}
      <div className="relative">
        {/* Soft gradient fade at the top of the scroll area — keeps the
            edge feeling soft instead of a hard cutoff against the header. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-6 pointer-events-none z-10"
          style={{
            background:
              'linear-gradient(180deg, var(--bg-primary) 0%, rgba(0,0,0,0) 100%)',
          }}
        />
        <div
          ref={containerRef}
          className="px-6 py-7 overflow-y-auto"
          style={{
            maxHeight: '480px',
            color: 'var(--text-secondary)',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
            fontSize: '18px',
            lineHeight: 1.9,
            fontWeight: 400,
            letterSpacing: '0.005em',
          }}
        >
          {perSection.map((seg, segIdx) => {
            const section = sections[seg.sectionIndex];
            if (!section || seg.words.length === 0) return null;
            return (
              <section key={seg.sectionIndex} className={segIdx > 0 ? 'mt-8' : ''}>
                {section.label && (
                  <h3
                    className="text-[10px] uppercase tracking-[0.2em] mb-3 font-semibold"
                    style={{ color: 'rgba(167,139,250,0.7)' }}
                  >
                    {section.label}
                  </h3>
                )}
                <p className="whitespace-pre-wrap">
                  {seg.words.map((w, i) => {
                    const flatIdx =
                      flatIdxLookup.get(`${seg.sectionIndex}:${i}`) ?? -1;
                    const isActive = flatIdx === activeFlatIdx;
                    const isPast =
                      activeFlatIdx >= 0 && flatIdx >= 0 && flatIdx < activeFlatIdx;
                    return (
                      <span key={`${seg.sectionIndex}-${i}`}>
                        <span
                          data-flat={flatIdx}
                          onClick={() => handleWordClick(w)}
                          className="cursor-pointer rounded-md transition-all duration-200 ease-out"
                          style={{
                            display: 'inline-block',
                            // Consistent padding on every word so the active
                            // chip doesn't push siblings around as it moves.
                            padding: '2px 6px',
                            margin: '0 -2px',
                            background: isActive ? '#7c3aed' : 'transparent',
                            color: isActive
                              ? '#fff'
                              : isPast
                                ? 'var(--text-muted)'
                                : 'var(--text-secondary)',
                            opacity: isPast ? 0.45 : 1,
                            boxShadow: isActive
                              ? '0 6px 20px rgba(124,58,237,0.45), 0 0 0 1px rgba(167,139,250,0.5) inset'
                              : 'none',
                            transform: isActive ? 'translateY(-1px)' : 'translateY(0)',
                          }}
                          title={`Jump to "${w.text}" — ${w.start.toFixed(2)}s`}
                        >
                          {w.text}
                        </span>
                        {i < seg.words.length - 1 ? ' ' : ''}
                      </span>
                    );
                  })}
                </p>
              </section>
            );
          })}
        </div>
        {/* Soft gradient fade at the bottom — mirrors the top fade and
            visually invites the reader to scroll down. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-8 pointer-events-none"
          style={{
            background:
              'linear-gradient(0deg, var(--bg-primary) 0%, rgba(0,0,0,0) 100%)',
          }}
        />
        {/* Hover-to-pause overlay. Only mounts while playing AND the
            mouse is over the teleprompter. Lets the reviewer stop at
            the exact word currently highlighted without aiming for the
            small waveform play button. Fades in with a 150ms
            transition; pointer-events-none on the backdrop so the
            words underneath stay clickable when the button is hidden. */}
        {onPause && (
          <div
            aria-hidden={!showPauseOverlay}
            className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 z-20"
            style={{
              opacity: showPauseOverlay ? 1 : 0,
              pointerEvents: showPauseOverlay ? 'auto' : 'none',
              background:
                'radial-gradient(circle at center, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.1) 60%, rgba(0,0,0,0) 100%)',
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPause();
              }}
              className="flex items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95"
              style={{
                width: 72,
                height: 72,
                background: 'rgba(124,58,237,0.92)',
                border: '1px solid rgba(167,139,250,0.55)',
                boxShadow:
                  '0 12px 40px rgba(0,0,0,0.45), 0 0 0 6px rgba(124,58,237,0.18)',
                cursor: 'pointer',
              }}
              title="Pause at this word"
            >
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="#fff"
                aria-label="Pause"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Sticky bottom action bar — always visible, never causes layout
          shift, single tap to comment at the current playhead. */}
      {onCommentHere && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2.5"
          style={{
            background: 'rgba(0,0,0,0.35)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {activeWordText ? (
              <>
                Active word:{' '}
                <span className="font-medium" style={{ color: '#a78bfa' }}>
                  &ldquo;{activeWordText}&rdquo;
                </span>
              </>
            ) : (
              'Press play to follow the narration word-by-word'
            )}
          </div>
          <button
            onClick={onCommentHere}
            className="shrink-0 text-[11px] px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 font-medium hover:brightness-110"
            style={{
              background:
                'linear-gradient(135deg, rgba(124,58,237,0.25) 0%, rgba(124,58,237,0.12) 100%)',
              color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.4)',
            }}
            title="Pause and write a comment pinned to this moment"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Comment here
          </button>
        </div>
      )}
    </div>
  );
}
