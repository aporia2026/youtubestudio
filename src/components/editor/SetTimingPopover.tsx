'use client';

/**
 * SetTimingPopover — precision input for a shot's start + end edges.
 *
 * Plan: `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`.
 *
 * Opens from the right-click "Set timing…" context-menu entry on any
 * shot card. Three coupled fields:
 *
 *   – Start    (m:ss or m:ss.t)
 *   – End      (m:ss or m:ss.t)
 *   – Duration (seconds, 2 decimals)
 *
 * Editing one re-derives the others (Start fixes End, then Duration =
 * End − Start; editing Duration fixes Start, sets End = Start + Dur).
 * Apply dispatches `SET_SHOT_TIMING { shotIndex, startMs, endMs }` —
 * the parent (EditorClient) wires the dispatch and surfaces any
 * clamp the reducer applied via a toast.
 *
 * Dismisses on Cancel / Escape / outside mousedown. Mirrors
 * `SetDurationPopover`'s portal + dismiss idioms so the two feel
 * identical from the user's perspective.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SetTimingPopoverProps {
  /** Title shown at the top of the popover. "Shot 71 timing" etc. */
  title: string;
  /** Viewport coords to anchor the popover at. Clamped to the viewport
   *  so the popover stays on-screen near the cursor. */
  x: number;
  y: number;
  /** Current start / end of the shot in ms (cascade-derived by the
   *  caller). Populate the inputs on mount. */
  initialStartMs: number;
  initialEndMs: number;
  /** Hard limits the popover enforces inline so Apply stays disabled
   *  on obviously-bad input. The reducer also clamps; these are the
   *  UI's first line of defense, mirroring EDITOR_MIN_SHOT_MS /
   *  EDITOR_MAX_SHOT_MS. */
  minDurationMs: number;
  maxDurationMs: number;
  /** First-shot path: Start input is disabled (start anchored at 0). */
  isFirstShot: boolean;
  /** Apply callback. The parent dispatches SET_SHOT_TIMING; the
   *  popover doesn't know about the reducer directly. */
  onApply: (startMs: number, endMs: number) => void;
  /** Close callback. Fires on Cancel / Escape / outside mousedown. */
  onClose: () => void;
}

const POPOVER_W_PX = 260;
const POPOVER_H_PX = 220;

/** Format an absolute time in ms as `m:ss` (whole seconds) or
 *  `m:ss.t` (when sub-second precision is meaningful). Matches the
 *  timeline ruler's labels the user sees in the screenshot. */
export function formatTimecode(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSec / 60);
  const sFloat = totalSec - m * 60;
  // 1-decimal precision when there are non-zero tenths; otherwise whole.
  const hasFraction = Math.round(sFloat * 10) % 10 !== 0;
  const sStr = hasFraction
    ? sFloat.toFixed(1).padStart(4, '0')
    : Math.round(sFloat).toString().padStart(2, '0');
  return `${m}:${sStr}`;
}

/** Parse `m:ss` / `m:ss.t` / `mm:ss` / bare seconds (`338.5`) →
 *  milliseconds, or `null` when the input doesn't match. More
 *  permissive than `parseTimecodeMs` in `@/lib/editor/store` (which
 *  is integer-second only) — we accept fractional seconds because
 *  the renderer's frame step (1/30s ≈ 33ms) makes sub-second
 *  precision meaningful to a careful editor. */
export function parseTimecodeMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const minutes = Number.parseInt(m[1], 10);
    const seconds = Number.parseFloat(m[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  // Bare seconds — useful for "338" or "338.5" pasted from elsewhere.
  const asSeconds = Number.parseFloat(trimmed);
  if (!Number.isFinite(asSeconds) || asSeconds < 0) return null;
  return Math.round(asSeconds * 1000);
}

export function SetTimingPopover({
  title,
  x,
  y,
  initialStartMs,
  initialEndMs,
  minDurationMs,
  maxDurationMs,
  isFirstShot,
  onApply,
  onClose,
}: SetTimingPopoverProps): React.ReactElement {
  // Two sources of truth in this popover: the parsed ms values (used
  // by validation + the apply dispatch) and the raw text strings (so
  // a user mid-typing "5:3" doesn't get their cursor yanked by a
  // re-format). We re-format only when a sibling field commits.
  const [startMs, setStartMs] = useState(initialStartMs);
  const [endMs, setEndMs] = useState(initialEndMs);
  const [startText, setStartText] = useState(() => formatTimecode(initialStartMs));
  const [endText, setEndText] = useState(() => formatTimecode(initialEndMs));
  const [durationText, setDurationText] = useState(
    () => ((initialEndMs - initialStartMs) / 1000).toFixed(2),
  );

  const popoverRef = useRef<HTMLDivElement>(null);

  // Mirror SetDurationPopover: mousedown beats the next React commit.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const left = x + POPOVER_W_PX > vw ? Math.max(8, vw - POPOVER_W_PX - 8) : x;
  const top = y + POPOVER_H_PX > vh ? Math.max(8, vh - POPOVER_H_PX - 8) : y;

  // ─── Field handlers ──────────────────────────────────────────────
  //
  // Editing Start: keep End fixed; derive Duration.
  // Editing End:   keep Start fixed; derive Duration.
  // Editing Dur:   keep Start fixed; derive End.
  //
  // Invalid input doesn't update the ms state — only the text state —
  // so the cursor stays put while the user keeps typing.

  const handleStartChange = (raw: string) => {
    setStartText(raw);
    const parsed = parseTimecodeMs(raw);
    if (parsed === null) return;
    setStartMs(parsed);
    setDurationText(((endMs - parsed) / 1000).toFixed(2));
  };

  const handleEndChange = (raw: string) => {
    setEndText(raw);
    const parsed = parseTimecodeMs(raw);
    if (parsed === null) return;
    setEndMs(parsed);
    setDurationText(((parsed - startMs) / 1000).toFixed(2));
  };

  const handleDurationChange = (raw: string) => {
    setDurationText(raw);
    const seconds = Number.parseFloat(raw.trim());
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const newEndMs = startMs + Math.round(seconds * 1000);
    setEndMs(newEndMs);
    setEndText(formatTimecode(newEndMs));
  };

  // ─── Validation ──────────────────────────────────────────────────

  const durationMs = endMs - startMs;
  const isStartValid = startMs >= 0;
  const isDurationValid =
    durationMs >= minDurationMs && durationMs <= maxDurationMs;
  const isValid = isStartValid && isDurationValid;
  const errorMessage = !isStartValid
    ? 'Start must be ≥ 0:00.'
    : durationMs < minDurationMs
      ? `Duration must be at least ${(minDurationMs / 1000).toFixed(0)}s.`
      : durationMs > maxDurationMs
        ? `Duration must be at most ${(maxDurationMs / 1000).toFixed(0)}s.`
        : null;

  const handleApply = () => {
    if (!isValid) return;
    console.info('[editor set-shot-timing] popover apply', {
      title,
      startMs,
      endMs,
      durationMs,
      initialStartMs,
      initialEndMs,
    });
    onApply(startMs, endMs);
    onClose();
  };

  const inputBaseStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '4px 6px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 4,
    color: 'var(--fg)',
    width: 90,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--fg-muted)',
    width: 72,
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  };

  const node = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 1300,
        width: POPOVER_W_PX,
        background: '#0f1115',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 6,
        padding: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        color: 'var(--fg)',
        fontSize: 11,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleApply();
        }
      }}
    >
      <div
        className="uppercase tracking-wider"
        style={{ fontSize: 10, color: 'var(--fg-muted)', marginBottom: 8 }}
      >
        {title}
      </div>
      <div style={rowStyle}>
        <label htmlFor="set-timing-start" style={labelStyle}>
          Start
        </label>
        <input
          id="set-timing-start"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={startText}
          disabled={isFirstShot}
          onChange={(e) => handleStartChange(e.target.value)}
          onBlur={() => setStartText(formatTimecode(startMs))}
          style={{
            ...inputBaseStyle,
            opacity: isFirstShot ? 0.5 : 1,
            cursor: isFirstShot ? 'not-allowed' : 'text',
          }}
          aria-label="Start timecode (m:ss)"
          autoFocus={!isFirstShot}
          title={
            isFirstShot
              ? "The first scene starts at 0:00 — can't be moved."
              : 'Format: m:ss or m:ss.t (e.g., 5:38 or 5:38.5)'
          }
        />
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>m:ss</span>
      </div>
      <div style={rowStyle}>
        <label htmlFor="set-timing-end" style={labelStyle}>
          End
        </label>
        <input
          id="set-timing-end"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={endText}
          onChange={(e) => handleEndChange(e.target.value)}
          onBlur={() => setEndText(formatTimecode(endMs))}
          style={inputBaseStyle}
          aria-label="End timecode (m:ss)"
          autoFocus={isFirstShot}
          title="Format: m:ss or m:ss.t"
        />
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>m:ss</span>
      </div>
      <div style={rowStyle}>
        <label htmlFor="set-timing-duration" style={labelStyle}>
          Duration
        </label>
        <input
          id="set-timing-duration"
          type="number"
          inputMode="decimal"
          min={minDurationMs / 1000}
          max={maxDurationMs / 1000}
          step={0.1}
          value={durationText}
          onChange={(e) => handleDurationChange(e.target.value)}
          onBlur={() => setDurationText((durationMs / 1000).toFixed(2))}
          style={inputBaseStyle}
          aria-label="Duration in seconds"
          title="Seconds (e.g., 4.5)"
        />
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>s</span>
      </div>
      {errorMessage && (
        <div
          style={{
            fontSize: 10,
            color: '#ef4444',
            marginTop: 4,
            marginBottom: 4,
          }}
        >
          {errorMessage}
        </div>
      )}
      <div className="flex items-center justify-end gap-1 mt-3">
        <button
          type="button"
          className="editor-btn"
          onClick={onClose}
          style={{ fontSize: 10 }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="editor-btn"
          onClick={handleApply}
          disabled={!isValid}
          style={{
            fontSize: 10,
            color: isValid ? 'var(--editor-accent)' : 'var(--fg-muted)',
            opacity: isValid ? 1 : 0.55,
            cursor: isValid ? 'pointer' : 'not-allowed',
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
