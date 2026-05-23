'use client';

/**
 * Narration strip — Phase 2 of
 * `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
 *
 * Sits directly under the Remotion preview in the editor's `preview`
 * slot. Reads the same `captions` bundle the CaptionsLane consumes
 * and prints the currently-active segment's text so the user always
 * sees what's being said as the playhead advances.
 *
 * Click on the line seeks to the start of the active segment — small
 * navigation convenience for "let me hear that again." Hidden
 * (returns null) when no captions are available so the editor's
 * vertical chrome stays unchanged for projects that don't have
 * captions yet.
 *
 * The strip is read-only. Editing caption text still lives on the
 * captions lane (double-click a pill) and on the Captions inspector
 * tab — duplicating that surface here would just clutter the
 * preview area.
 */

import { useMemo } from 'react';
import { activeCaption, type CaptionsBundle } from '@/lib/editor/captions';

interface NarrationStripProps {
  /** The full captions bundle. `undefined` when captions haven't been
   *  generated yet — the strip hides itself entirely in that case. */
  captions: CaptionsBundle | undefined;
  /** Current playhead position in ms. */
  playheadMs: number;
  /** Seek callback — wired to `seekFromUser` so the Remotion player
   *  follows the move. */
  onSeek: (ms: number) => void;
  /** Font size in px. Tracks the
   *  `editor.narration.fontSize` setting; defaults to 14 if not set. */
  fontSize?: number;
}

export function NarrationStrip({
  captions,
  playheadMs,
  onSeek,
  fontSize = 14,
}: NarrationStripProps): React.ReactElement | null {
  // Resolve the active segment once per playhead tick. The lookup is
  // cheap (linear scan of ≤ 200 segments) but memoizing keeps the
  // strip from re-deriving on unrelated re-renders.
  const active = useMemo(
    () => activeCaption(captions?.segments, playheadMs / 1000),
    [captions, playheadMs],
  );

  // Hide entirely when there are no captions at all. We deliberately
  // do NOT show a placeholder ("waiting for captions...") — that
  // creates dead vertical space for projects that don't use captions.
  if (!captions || captions.segments.length === 0) {
    return null;
  }

  const handleClick = () => {
    if (!active) return;
    const ms = Math.round(active.start * 1000);
    console.info('[editor narration-strip] click-seek', {
      segmentStart: active.start,
      ms,
      textPrefix: active.text.slice(0, 40),
    });
    onSeek(ms);
  };

  return (
    <div
      onClick={handleClick}
      role={active ? 'button' : undefined}
      tabIndex={active ? 0 : undefined}
      onKeyDown={
        active
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
      className="editor-panel rounded-md"
      style={{
        marginTop: 6,
        padding: '8px 12px',
        minHeight: 32,
        background: 'var(--editor-panel)',
        border: '1px solid var(--editor-edge)',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        fontSize,
        lineHeight: 1.4,
        cursor: active ? 'pointer' : 'default',
        // Truncate to a single line — captions can be long, and a
        // wrapping strip would push the timeline down by a variable
        // amount which looks janky during playback. Hovering shows
        // the full segment text.
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
      title={active ? `Click to seek to "${active.text.slice(0, 60)}…"` : ''}
      aria-live="polite"
      aria-label={active ? `Now narrating: ${active.text}` : 'No narration at this point'}
    >
      {active ? (
        active.text
      ) : (
        <span style={{ fontStyle: 'italic' }}>— silence —</span>
      )}
    </div>
  );
}
