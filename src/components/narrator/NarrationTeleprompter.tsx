'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { findActiveWordIndex, sliceAlignmentToSections } from '@/lib/narrator-utils';
import { stripProductionCues } from '@/lib/utils';
import type { ForcedAlignmentResponse, ForcedAlignmentWord } from '@/lib/elevenlabs';

interface NarrationTeleprompterProps {
  /** Sections in the same order they were sent to the aligner. When
   *  `alignment` is null we render `script_text` directly (production
   *  cues stripped) instead of the aligner's word array. */
  sections: Array<{ label?: string | null; script_text: string }>;
  /** Raw ElevenLabs forced-alignment payload. Null when alignment
   *  failed / is pending / is in flight — the teleprompter then
   *  renders static text in the same typography so sync mode always
   *  shows the new design. */
  alignment: ForcedAlignmentResponse | null;
  /** Current playhead in ms. */
  currentMs: number;
  /** Total audio duration in ms. Used by the fullscreen transport bar
   *  for the scrub width + time readout. Optional because the
   *  non-fullscreen view doesn't render a transport bar (the
   *  WaveformPlayer above the teleprompter is the source of truth). */
  durationMs?: number;
  /** Click a word → seek the audio to that word's start. */
  onSeek: (ms: number) => void;
  /** Optional: called when the reviewer clicks the "Comment" button in
   *  the sticky bottom bar. Parent pauses playback and scrolls/focuses
   *  the comment input. The bar is the discovery affordance so the
   *  reviewer doesn't have to scroll down to find the comment textarea. */
  onCommentHere?: () => void;
  /** Whether the underlying audio is currently playing. Drives the icon
   *  shown by the hover transport overlay — Pause when playing, Play
   *  when paused. */
  isPlaying?: boolean;
  /** Called when the reviewer clicks the hover transport button. Should
   *  toggle playback (pause if playing, resume if paused) without
   *  seeking. */
  onTogglePlay?: () => void;
  /** Called when the inline composer in fullscreen mode submits a
   *  comment. Parent posts to the comments API. Should throw on
   *  failure so the composer can re-enable its submit button and
   *  surface the error. */
  onSubmitComment?: (text: string) => Promise<void>;
  /** Called before opening the inline composer in fullscreen — used to
   *  pause playback so the reviewer can concentrate on writing without
   *  the script scrolling past underneath. */
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
  durationMs = 0,
  onSeek,
  onCommentHere,
  isPlaying = false,
  onTogglePlay,
  onSubmitComment,
  onPause,
}: NarrationTeleprompterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const userScrollAtRef = useRef<number>(0);
  const [followLocked, setFollowLocked] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Fullscreen state: when true, the wrapper pins to position:fixed
  // inset:0 and the body uses larger typography. Enables the inline
  // composer so the reviewer can still comment without leaving the
  // fullscreen view.
  const [fullscreen, setFullscreen] = useState(false);
  // Inline composer state — only meaningful when fullscreen is true.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [composerSubmitting, setComposerSubmitting] = useState(false);

  // Esc closes the composer first (if open), otherwise exits
  // fullscreen. Matches platform convention — one stack of dismissals.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (composerOpen) setComposerOpen(false);
        else setFullscreen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, composerOpen]);

  // Body scroll lock while fullscreen — prevents the page underneath
  // from scrolling when the reviewer scrolls over the gradient fade
  // edges of the teleprompter.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // Auto-focus the composer textarea when it opens so the reviewer can
  // start typing immediately. Defer past the open transition so the
  // focus ring doesn't render mid-animation.
  useEffect(() => {
    if (!composerOpen) return;
    const t = setTimeout(() => composerRef.current?.focus(), 150);
    return () => clearTimeout(t);
  }, [composerOpen]);

  function openInlineComposer() {
    // Pause first so the script doesn't scroll past while the reviewer
    // is mid-sentence. No-op if already paused.
    if (isPlaying && onPause) onPause();
    setComposerText('');
    setComposerOpen(true);
  }

  async function handleComposerSubmit() {
    if (!onSubmitComment || composerSubmitting) return;
    const text = composerText.trim();
    if (!text) return;
    setComposerSubmitting(true);
    try {
      await onSubmitComment(text);
      setComposerText('');
      setComposerOpen(false);
    } catch (err) {
      console.error('Inline composer submit failed:', err);
      // Leave the text in place so the reviewer can retry without
      // losing their work. The throw bubbles to the caller's toast.
    } finally {
      setComposerSubmitting(false);
    }
  }

  /** M:SS formatter for the fullscreen transport readout. */
  function formatClock(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /** Seek to the click position on the scrub bar. */
  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    if (durationMs <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(pct * durationMs);
  }

  function onCommentButtonClick() {
    // In fullscreen we keep the reviewer in fullscreen by opening the
    // inline composer instead of bouncing them back to the page's
    // textarea. Out of fullscreen, fall back to the parent's
    // pause+scroll-to-textarea handler.
    if (fullscreen && onSubmitComment) {
      openInlineComposer();
    } else if (onCommentHere) {
      onCommentHere();
    }
  }

  // Slice the flat alignment into per-section word arrays. Empty when
  // alignment is null (static-text mode); the renderer falls back to
  // section.script_text in that branch. Stable across currentMs
  // changes — only re-computes when sections/alignment do.
  const perSection = useMemo(
    () => (alignment ? sliceAlignmentToSections(alignment, sections) : []),
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
    // If audio was paused, start playback from the clicked word —
    // matches reviewer intuition ("click means 'go and play from
    // here'"). When audio was already playing, seek alone is enough;
    // togglePlay would pause it.
    if (!isPlaying && onTogglePlay) {
      onTogglePlay();
    }
  }

  // Static-text mode: alignment isn't ready (failed, pending, or in
  // flight). Render the script as plain words in the same typography
  // so sync mode never drops back to the classic ScriptFollow look —
  // the new design covers both states.
  const isStaticMode = !alignment || flatWords.length === 0;

  // Hover transport overlay — shows whenever the mouse is over the
  // teleprompter and the parent passed an onTogglePlay handler. The
  // icon swaps based on play state so the same affordance handles both
  // "pause at this word" and "resume from here".
  const showTransportOverlay = hovered && !!onTogglePlay;

  return (
    <div
      className={fullscreen ? 'fixed inset-0 z-50 flex flex-col' : 'rounded-xl overflow-hidden relative'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={
        fullscreen
          ? {
              background:
                'radial-gradient(circle at 50% 0%, rgba(124,58,237,0.08) 0%, rgba(10,10,12,1) 60%), #0a0a0c',
              backdropFilter: 'blur(4px)',
            }
          : {
              background:
                'linear-gradient(180deg, rgba(124,58,237,0.05) 0%, rgba(124,58,237,0) 200px), var(--bg-primary)',
              border: '1px solid var(--border)',
              boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset',
            }
      }
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
            {isStaticMode ? '· static view' : '· word-accurate sync'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
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
          <button
            onClick={() => setFullscreen((v) => !v)}
            className="text-[10px] px-2 py-1 rounded-md transition-colors cursor-pointer flex items-center gap-1"
            style={{
              background: fullscreen ? 'rgba(124,58,237,0.18)' : 'transparent',
              color: fullscreen ? '#a78bfa' : 'var(--text-muted)',
              border: `1px solid ${fullscreen ? 'rgba(124,58,237,0.4)' : 'rgba(255,255,255,0.08)'}`,
            }}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Expand to fullscreen'}
          >
            {fullscreen ? (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
                </svg>
                Exit fullscreen
              </>
            ) : (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
                </svg>
                Expand
              </>
            )}
          </button>
        </div>
      </div>

      {/* Reading body */}
      <div className={`relative ${fullscreen ? 'flex-1 min-h-0' : ''}`}>
        {/* Soft gradient fade at the top of the scroll area — keeps the
            edge feeling soft instead of a hard cutoff against the header. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-6 pointer-events-none z-10"
          style={{
            background: fullscreen
              ? 'linear-gradient(180deg, #0a0a0c 0%, rgba(0,0,0,0) 100%)'
              : 'linear-gradient(180deg, var(--bg-primary) 0%, rgba(0,0,0,0) 100%)',
          }}
        />
        <div
          ref={containerRef}
          className={fullscreen ? 'h-full overflow-y-auto' : 'overflow-y-auto'}
          style={{
            // Fullscreen gets viewport-based height + generous side
            // padding + a max-width so lines don't stretch to a
            // squint-wide measure on wide monitors.
            maxHeight: fullscreen ? '100%' : '480px',
            padding: fullscreen ? '40px max(48px, 8vw)' : '28px 24px',
            color: 'var(--text-secondary)',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
            fontSize: fullscreen ? '22px' : '18px',
            lineHeight: fullscreen ? 2.0 : 1.9,
            fontWeight: 400,
            letterSpacing: '0.005em',
          }}
        >
          {/* Max-width wrapper so lines stay readable on wide monitors
              when fullscreen. No-op out of fullscreen because the
              parent card constrains the width already. */}
          <div style={fullscreen ? { maxWidth: 920, margin: '0 auto' } : undefined}>
          {isStaticMode
            ? // Static-text branch: no per-word timings, render each
              // section's spoken text (production cues stripped) in the
              // same typography as the synced view. No active-word
              // highlighting, no click-to-seek — there are no word
              // boundaries to seek to.
              sections.map((section, segIdx) => {
                const spoken = stripProductionCues(section.script_text).trim();
                if (!spoken) return null;
                return (
                  <section key={segIdx} className={segIdx > 0 ? 'mt-8' : ''}>
                    {section.label && (
                      <h3
                        className="text-[10px] uppercase tracking-[0.2em] mb-3 font-semibold"
                        style={{ color: 'rgba(167,139,250,0.7)' }}
                      >
                        {section.label}
                      </h3>
                    )}
                    <p className="whitespace-pre-wrap">{spoken}</p>
                  </section>
                );
              })
            : // Synced branch: render the aligner's word array with the
              // active-word chip and click-to-seek behaviour.
              perSection.map((seg, segIdx) => {
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
                                // Consistent padding on every word so the
                                // active chip doesn't push siblings around
                                // as it moves.
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
                                transform: isActive
                                  ? 'translateY(-1px)'
                                  : 'translateY(0)',
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
        </div>
        {/* Soft gradient fade at the bottom — mirrors the top fade and
            visually invites the reader to scroll down. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-8 pointer-events-none"
          style={{
            background: fullscreen
              ? 'linear-gradient(0deg, #0a0a0c 0%, rgba(0,0,0,0) 100%)'
              : 'linear-gradient(0deg, var(--bg-primary) 0%, rgba(0,0,0,0) 100%)',
          }}
        />
        {/* Hover-to-toggle transport overlay. Surfaces a big centred
            button whenever the mouse is over the teleprompter — Pause
            when playing, Play when paused — so the reviewer can stop
            at the exact word currently highlighted (or resume from
            there) without aiming for the small waveform transport.
            Fades in with a 150ms transition; pointer-events-none on
            the backdrop so the words underneath stay clickable when
            the button is hidden. */}
        {onTogglePlay && (
          <div
            aria-hidden={!showTransportOverlay}
            className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 z-20"
            style={{
              opacity: showTransportOverlay ? 1 : 0,
              // Backdrop is ALWAYS pointer-events: none — only the button
              // catches clicks. Otherwise the dimmed area around the
              // button would swallow clicks meant for the words
              // underneath, defeating click-to-seek. Hover detection
              // still works because mouseenter on the outer wrapper
              // bubbles from the words below the (transparent) backdrop.
              pointerEvents: 'none',
              background:
                'radial-gradient(circle at center, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.1) 60%, rgba(0,0,0,0) 100%)',
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePlay();
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
                // Only the button itself receives clicks. Disabled when
                // overlay is hidden so a stray click in the centre
                // doesn't accidentally toggle playback.
                pointerEvents: showTransportOverlay ? 'auto' : 'none',
              }}
              title={isPlaying ? 'Pause at this word' : 'Play from this word'}
            >
              {isPlaying ? (
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
              ) : (
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="#fff"
                  aria-label="Play"
                  // Optical centring: the play triangle's visual centre
                  // sits slightly left of its bounding box, so nudge
                  // the icon right by 2px to feel centred in the
                  // circle.
                  style={{ marginLeft: 2 }}
                >
                  <path d="M7 4 L20 12 L7 20 Z" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Fullscreen-only transport bar. Out of fullscreen, the
          WaveformPlayer above the teleprompter already provides scrub +
          transport — duplicating it here would be confusing. In
          fullscreen the WaveformPlayer is hidden behind the overlay,
          so the reviewer needs a way to scrub, skip, and read the
          time without exiting. The bar drives the same audio element
          via the parent's onSeek / onTogglePlay handlers — no second
          WaveSurfer instance. */}
      {fullscreen && (
        <div
          className="px-6 py-3 flex items-center gap-4"
          style={{
            background: 'rgba(0,0,0,0.45)',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {/* Transport buttons — play/pause, skip back 5s, skip
              forward 5s. Mirrors the WaveformPlayer's transport so
              keyboard/mouse muscle memory carries over. */}
          {onTogglePlay && (
            <button
              onClick={onTogglePlay}
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors cursor-pointer"
              style={{
                background: isPlaying ? 'rgba(124,58,237,0.85)' : 'rgba(124,58,237,0.2)',
                border: `1px solid rgba(167,139,250,${isPlaying ? 0.55 : 0.3})`,
              }}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#a78bfa" style={{ marginLeft: 2 }}>
                  <path d="M7 4 L20 12 L7 20 Z" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={() => onSeek(Math.max(0, currentMs - 5000))}
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-md cursor-pointer transition-colors flex items-center gap-1"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            title="Back 5 seconds"
          >
            ◀ 5s
          </button>
          <button
            onClick={() =>
              onSeek(
                durationMs > 0
                  ? Math.min(durationMs, currentMs + 5000)
                  : currentMs + 5000,
              )
            }
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-md cursor-pointer transition-colors flex items-center gap-1"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            title="Forward 5 seconds"
          >
            5s ▶
          </button>
          {/* Scrub bar — click anywhere to seek. Filled portion shows
              progress; faint track fills the remainder. Disabled
              (no-op) before duration is known. */}
          <div
            onClick={handleScrubClick}
            className="flex-1 h-1.5 rounded-full relative cursor-pointer"
            style={{
              background: 'rgba(255,255,255,0.08)',
              cursor: durationMs > 0 ? 'pointer' : 'default',
            }}
            title={durationMs > 0 ? 'Click to seek' : 'Loading…'}
          >
            <div
              className="h-full rounded-full transition-[width] duration-100 ease-out"
              style={{
                width: durationMs > 0 ? `${(currentMs / durationMs) * 100}%` : '0%',
                background: 'linear-gradient(90deg, #7c3aed 0%, #a78bfa 100%)',
                boxShadow: '0 0 8px rgba(124,58,237,0.5)',
              }}
            />
            {durationMs > 0 && (
              <div
                aria-hidden
                className="absolute top-1/2 w-3 h-3 rounded-full pointer-events-none"
                style={{
                  left: `${(currentMs / durationMs) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  background: '#fff',
                  boxShadow: '0 0 0 2px #7c3aed, 0 2px 8px rgba(0,0,0,0.5)',
                }}
              />
            )}
          </div>
          <span
            className="shrink-0 text-[11px] font-mono tabular-nums"
            style={{ color: 'var(--text-muted)' }}
          >
            {formatClock(currentMs)} / {formatClock(durationMs)}
          </span>
        </div>
      )}

      {/* Sticky bottom action bar — collapses into an inline composer
          while writing in fullscreen so the reviewer never leaves the
          fullscreen view to leave a comment. Out of fullscreen the bar
          falls through to the parent's pause+focus-textarea handler so
          the existing single-page composer is still where comments
          land. */}
      {(onCommentHere || onSubmitComment) &&
        (composerOpen && fullscreen && onSubmitComment ? (
          // Inline composer — only in fullscreen. Pause-on-open is
          // handled by openInlineComposer.
          <div
            className="px-4 py-3 flex items-start gap-3"
            style={{
              background: 'rgba(0,0,0,0.45)',
              borderTop: '1px solid var(--border)',
              maxWidth: 1100,
              width: '100%',
              alignSelf: 'center',
            }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.15em] mb-1.5 font-semibold" style={{ color: 'var(--text-muted)' }}>
                Comment {activeWordText && (
                  <span style={{ color: '#a78bfa' }}>
                    on &ldquo;{activeWordText}&rdquo;
                  </span>
                )}
              </div>
              <textarea
                ref={composerRef}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleComposerSubmit();
                  }
                }}
                placeholder="What did you notice at this moment? (⌘/Ctrl+Enter to submit, Esc to cancel)"
                rows={2}
                disabled={composerSubmitting}
                className="w-full text-sm rounded-md p-2 resize-none outline-none transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-primary)',
                  border: '1px solid rgba(124,58,237,0.35)',
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5 pt-5">
              <button
                onClick={handleComposerSubmit}
                disabled={composerSubmitting || !composerText.trim()}
                className="text-[11px] px-3 py-1.5 rounded-md font-medium text-white cursor-pointer transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: '#7c3aed' }}
                title="Submit comment (⌘/Ctrl+Enter)"
              >
                {composerSubmitting ? 'Posting…' : 'Submit'}
              </button>
              <button
                onClick={() => setComposerOpen(false)}
                disabled={composerSubmitting}
                className="text-[11px] px-3 py-1.5 rounded-md cursor-pointer transition-colors disabled:opacity-40"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
                title="Cancel (Esc)"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5"
            style={{
              background: 'rgba(0,0,0,0.35)',
              borderTop: '1px solid var(--border)',
            }}
          >
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {isStaticMode ? (
                'Word-accurate sync unavailable for this take'
              ) : activeWordText ? (
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
              onClick={onCommentButtonClick}
              className="shrink-0 text-[11px] px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 font-medium hover:brightness-110"
              style={{
                background:
                  'linear-gradient(135deg, rgba(124,58,237,0.25) 0%, rgba(124,58,237,0.12) 100%)',
                color: '#a78bfa',
                border: '1px solid rgba(124,58,237,0.4)',
              }}
              title={
                fullscreen && onSubmitComment
                  ? 'Pause and write a comment pinned to this moment'
                  : 'Pause and jump to the comment input below'
              }
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Comment here
            </button>
          </div>
        ))}
    </div>
  );
}
