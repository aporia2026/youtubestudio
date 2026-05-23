'use client';

/**
 * InsertSceneAffordance — hover-revealed "+" at the seam between two
 * timeline shot cards, opening a popover with two insert modes.
 *
 * Plan: `_plans/2026-05-23-editor-insert-blank-scene-between.md`.
 *
 *   – Carve from neighbor (default): the new scene steals time from
 *     a neighbor so total project length is unchanged. Fixes audio-
 *     vs-visual mismatches at this seam without cascading downstream.
 *
 *   – Add new time (shift): the new scene extends total length;
 *     voiceover plays through, downstream visuals shift later.
 *
 * Visual idiom borrowed from `SetDurationPopover`: portal to body,
 * dismiss on outside mousedown + Escape, anchor at viewport coords.
 * Hover affordance idiom mirrors the cross-fade chip in `Timeline`:
 * `opacity-0 group-hover:opacity-100` on a parent that's always in
 * the DOM (no mount thrash on every hover).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Width of the seam hover zone in px. Wide enough that a casual
 *  mouseover catches it; narrow enough that it doesn't fight the
 *  adjacent cards' edge handles. Centered on the seam via
 *  translateX(-50%). */
const HOVER_ZONE_WIDTH = 14;
const BUTTON_SIZE = 22;
/** Vertical extent of the hover zone in px. Limited to the top strip
 *  where the "+" button visually sits so the zone does NOT cover the
 *  full STRIP_HEIGHT and silently swallow pointer events for the
 *  card's resize handle (z-10, centered on the same seam) and the
 *  card's leading trim handle (z-10, just inside the seam). Without
 *  this cap the wrapper at z-30 wins the hit-test along the entire
 *  strip and timeline resize/trim feels broken everywhere a seam
 *  intersects an edge handle. */
const HOVER_ZONE_HEIGHT = BUTTON_SIZE + 8;
const POPOVER_WIDTH = 232;
/** Approximate; used to keep the popover on-screen when the seam is
 *  near the viewport's bottom edge. Real height varies with content
 *  but stays close to this value. */
const POPOVER_HEIGHT = 132;

export interface InsertSceneAffordanceProps {
  /** Insertion index in `doc.rows` (0..rows.length). Passed back to
   *  the parent's `onInsert` callback. */
  atIndex: number;
  /** Horizontal offset within the timeline strip where the seam sits,
   *  in px. The component centers the hover zone on this X. */
  seamX: number;
  /** Strip height in px — the hover zone spans this so the seam is
   *  catchable anywhere along the cards' vertical edge. */
  height: number;
  /** Effective duration of the row to the LEFT of the seam, in ms.
   *  Drives carve eligibility. Undefined when the seam is before
   *  the first row. */
  leftDurationMs?: number;
  /** Effective duration of the row to the RIGHT of the seam, in ms.
   *  Undefined when the seam is after the last row. */
  rightDurationMs?: number;
  /** New scene's default duration in ms. From editor settings;
   *  defaults to 2000ms when the user hasn't set one. */
  defaultDurationMs: number;
  /** Minimum shot duration the renderer enforces, in ms. Used to
   *  decide carve eligibility — a neighbor must have at least
   *  `2 × minShotMs` to give `minShotMs` and keep `minShotMs`.
   *  Mirrors `EDITOR_MIN_SHOT_MS` from the store. */
  minShotMs: number;
  /** Fired when the user picks an insert mode. `carveFrom` is only
   *  defined for `mode === 'carve'`. */
  onInsert: (mode: 'carve' | 'shift', carveFrom?: 'left' | 'right' | 'auto') => void;
}

export function InsertSceneAffordance({
  atIndex,
  seamX,
  height,
  leftDurationMs,
  rightDurationMs,
  defaultDurationMs,
  minShotMs,
  onInsert,
}: InsertSceneAffordanceProps): React.ReactElement {
  const [popoverAt, setPopoverAt] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // A neighbor can yield at most `eff - minShotMs` worth of carve while
  // staying above the floor itself; the new row needs at least
  // `minShotMs`. So the gate is `eff ≥ 2 × minShotMs`.
  const canGive = (d: number | undefined) =>
    typeof d === 'number' && d >= 2 * minShotMs;
  const canCarve = canGive(leftDurationMs) || canGive(rightDurationMs);

  const handleToggle = () => {
    if (popoverAt) {
      setPopoverAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopoverAt({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
  };

  const handlePick = (mode: 'carve' | 'shift', carveFrom?: 'left' | 'right' | 'auto') => {
    console.info('[editor insert-shot] dispatch', {
      atIndex,
      mode,
      carveFrom,
      durationMs: defaultDurationMs,
      leftDurationMs,
      rightDurationMs,
    });
    onInsert(mode, carveFrom);
    setPopoverAt(null);
  };

  return (
    <>
      <div
        className="absolute top-0 z-30 group"
        style={{
          left: seamX,
          width: HOVER_ZONE_WIDTH,
          // Cap at HOVER_ZONE_HEIGHT (not full strip height) so the
          // resize / trim / reorder handles below the top strip stay
          // hittable. See the constant above for context.
          height: Math.min(height, HOVER_ZONE_HEIGHT),
          transform: 'translateX(-50%)',
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          onPointerDown={(e) => {
            // Stop the dnd-kit pointer sensor on the adjacent card
            // from grabbing this gesture as a reorder drag.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleToggle();
          }}
          className={`absolute left-1/2 -translate-x-1/2 rounded-full flex items-center justify-center font-medium leading-none transition-opacity ${
            popoverAt
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto'
          }`}
          style={{
            // Anchor near the top of the strip — out of the way of the
            // cross-fade chip (vertical center, `top: 50%` on each
            // card's leading edge) and the card's title/duration text
            // at the bottom. Fully inside the strip so the parent's
            // `overflow: hidden` doesn't clip the round button.
            top: 4,
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            fontSize: 14,
            background: 'var(--accent-purple-bright, #a78bfa)',
            color: '#0b0d12',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}
          title={`Insert scene at position ${atIndex + 1}`}
          aria-label={`Insert scene at position ${atIndex + 1}`}
        >
          +
        </button>
      </div>
      {popoverAt && (
        <InsertScenePopover
          atIndex={atIndex}
          x={popoverAt.x}
          y={popoverAt.y}
          canCarve={canCarve}
          defaultDurationMs={defaultDurationMs}
          minShotMs={minShotMs}
          triggerRef={buttonRef}
          onPick={handlePick}
          onClose={() => setPopoverAt(null)}
        />
      )}
    </>
  );
}

// ─── Popover (portaled) ─────────────────────────────────────────

interface InsertScenePopoverProps {
  atIndex: number;
  x: number;
  y: number;
  canCarve: boolean;
  defaultDurationMs: number;
  minShotMs: number;
  /** Trigger button ref — the outside-click handler ignores clicks on
   *  the trigger so the button's own toggle handler fires cleanly. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (mode: 'carve' | 'shift', carveFrom?: 'left' | 'right' | 'auto') => void;
  onClose: () => void;
}

function InsertScenePopover({
  atIndex,
  x,
  y,
  canCarve,
  defaultDurationMs,
  minShotMs,
  triggerRef,
  onPick,
  onClose,
}: InsertScenePopoverProps): React.ReactElement {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Mirror SetDurationPopover: mousedown beats the next React commit
  // so the popover dismisses before any click-target re-renders fire.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && canCarve) {
        e.preventDefault();
        onPick('carve', 'auto');
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [canCarve, onClose, onPick, triggerRef]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const left = Math.max(
    8,
    Math.min(vw - POPOVER_WIDTH - 8, x - POPOVER_WIDTH / 2),
  );
  const top = Math.max(8, Math.min(vh - POPOVER_HEIGHT - 8, y));

  const seconds = (defaultDurationMs / 1000).toFixed(1);
  const requiredSeconds = (2 * minShotMs / 1000).toFixed(0);

  const node = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Insert scene at position ${atIndex + 1}`}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 1300,
        width: POPOVER_WIDTH,
        background: '#0f1115',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 6,
        padding: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        color: 'var(--fg)',
        fontSize: 11,
      }}
    >
      <div
        className="uppercase tracking-wider"
        style={{ fontSize: 10, color: 'var(--fg-muted)', marginBottom: 8 }}
      >
        Insert blank scene
      </div>
      <button
        type="button"
        autoFocus={canCarve}
        disabled={!canCarve}
        onClick={() => onPick('carve', 'auto')}
        className="w-full text-left rounded"
        style={{
          padding: '6px 8px',
          marginBottom: 6,
          fontSize: 11,
          color: canCarve ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--fg-muted)',
          border: `1px solid ${
            canCarve ? 'var(--accent-purple-bright, #a78bfa)' : 'rgba(255,255,255,0.10)'
          }`,
          background: canCarve ? 'rgba(167,139,250,0.08)' : 'transparent',
          opacity: canCarve ? 1 : 0.55,
          cursor: canCarve ? 'pointer' : 'not-allowed',
        }}
        title={
          canCarve
            ? 'Steal time from a neighbor. Total length unchanged; voiceover stays aligned.'
            : `Neither neighbor has enough slack (need ≥ ${requiredSeconds}s).`
        }
      >
        <div style={{ fontWeight: 600 }}>Carve from neighbor</div>
        <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 2 }}>
          {canCarve
            ? 'Keeps total length. Fixes mismatches.'
            : `Both neighbors below ${requiredSeconds}s — too short.`}
        </div>
      </button>
      <button
        type="button"
        autoFocus={!canCarve}
        onClick={() => onPick('shift')}
        className="w-full text-left rounded"
        style={{
          padding: '6px 8px',
          fontSize: 11,
          color: 'var(--fg)',
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'pointer',
        }}
        title={`Add ${seconds}s of new visual time. Total length grows; voiceover plays through.`}
      >
        <div style={{ fontWeight: 600 }}>Add {seconds}s of new time</div>
        <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 2 }}>
          Total length grows. Voiceover plays through.
        </div>
      </button>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
