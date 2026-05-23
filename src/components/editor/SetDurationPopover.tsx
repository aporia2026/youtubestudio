'use client';

/**
 * SetDurationPopover — Phase 3 of
 * `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
 *
 * Tiny floating popover anchored at viewport coords (typically the
 * cursor position when the user picked "Set duration…" from a
 * context menu). Lets the user dial a new duration via either a
 * slider (lazy-user path) or a numeric ms input (precision path),
 * per the §12 resolved-question decision. Apply commits; Cancel /
 * Escape / click-outside dismiss.
 *
 * Pure presentational — the popover takes a current value + a
 * commit callback. The parent (EditorClient) wires the commit to
 * the matching store dispatch (RESIZE_SHOT for shot duration,
 * future surfaces can wire other actions to the same popover).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SetDurationPopoverProps {
  /** Title rendered at the top of the popover so the user sees what
   *  they're editing ("Shot 7 duration", "Caption #3 length", etc). */
  title: string;
  /** Viewport coords where the popover should anchor. Clamped to the
   *  viewport so a click near the edge of the screen doesn't push
   *  the popover offscreen. */
  x: number;
  y: number;
  /** Current value in ms — populates the slider + input on mount. */
  initialMs: number;
  /** Hard limits the popover enforces. Caller supplies these from
   *  the relevant catalog (EDITOR_MIN_SHOT_MS / EDITOR_MAX_SHOT_MS
   *  for shots; smaller bounds for things like fades). */
  minMs: number;
  maxMs: number;
  /** Slider step size in ms. Defaults to 100 ms — fine enough for
   *  shot durations, coarse enough that the slider doesn't feel
   *  jittery. Caller can override for finer surfaces. */
  stepMs?: number;
  /** Apply callback. Fires when the user clicks Apply OR presses
   *  Enter. The parent is responsible for dispatching the matching
   *  store command. */
  onApply: (ms: number) => void;
  /** Close callback. Fires on Cancel / Escape / outside click. */
  onClose: () => void;
}

const POPOVER_W_PX = 240;
const POPOVER_H_PX = 130;

export function SetDurationPopover({
  title,
  x,
  y,
  initialMs,
  minMs,
  maxMs,
  stepMs = 100,
  onApply,
  onClose,
}: SetDurationPopoverProps): React.ReactElement {
  const [value, setValue] = useState(() =>
    Math.max(minMs, Math.min(maxMs, Math.round(initialMs))),
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape. Mirrors the OverlayContextMenu
  // pattern (mousedown so we beat the next React commit; click would
  // race with selection state and feel laggy).
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

  const clamp = (n: number) =>
    Math.max(minMs, Math.min(maxMs, Math.round(n)));

  const handleApply = () => {
    console.info('[editor set-duration-popover] apply', {
      title,
      ms: value,
      initialMs,
    });
    onApply(value);
    onClose();
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
        style={{ fontSize: 10, color: 'var(--fg-muted)', marginBottom: 6 }}
      >
        {title}
      </div>
      <input
        type="range"
        min={minMs}
        max={maxMs}
        step={stepMs}
        value={value}
        onChange={(e) => setValue(clamp(Number(e.target.value)))}
        className="w-full"
        aria-label={`${title} (slider)`}
        autoFocus
      />
      <div className="flex items-center gap-2 mt-2">
        <input
          type="number"
          min={minMs}
          max={maxMs}
          step={stepMs}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setValue(clamp(n));
          }}
          className="editor-input flex-1"
          style={{ fontSize: 11 }}
          aria-label={`${title} (milliseconds)`}
        />
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>ms</span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-3">
        <span className="tabular-nums ed-mono" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
          {(value / 1000).toFixed(2)}s
        </span>
        <div className="flex items-center gap-1">
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
            style={{ fontSize: 10, color: 'var(--editor-accent)' }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
