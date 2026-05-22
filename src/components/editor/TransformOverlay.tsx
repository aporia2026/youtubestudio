'use client';

/**
 * Canva-style free-transform overlay — Batch B of
 * `_plans/2026-05-23-editor-canva-transform.md`.
 *
 * Mounts as an absolutely-positioned layer over the Remotion Player.
 * When a shot is selected and the shot has an imageUrl / videoUrl, the
 * overlay shows a selection box around the visual's current bounds
 * (computed from `image_x_pct`, `image_y_pct`, `image_scale_pct`).
 *
 * Interactions:
 *   - Drag the body of the selection → translates the visual
 *     (updates image_x_pct, image_y_pct).
 *   - Drag a corner handle → scales the visual (aspect-locked).
 *
 * Pointer math:
 *   - The Player composes at 1920×1080 and is rendered with
 *     objectFit: contain inside the preview container, so the
 *     ACTUAL canvas rect is letterboxed inside the parent. We
 *     measure the parent via ResizeObserver and compute the contained
 *     16:9 rect ourselves. All deltas are converted to canvas-relative
 *     percentages before dispatching, so the renderer reads them as
 *     resolution-independent.
 *
 * State:
 *   - Local refs hold the active drag handle + the at-pointerdown
 *     transform snapshot. State updates fire optimistically via
 *     `onChange` for live feedback, and the final commit fires on
 *     pointerup (the parent dispatches PATCH_ROW which puts the change
 *     on the undo stack).
 *
 * Batch C will add edge handles, rotation, snap guides, and keyboard
 * nudges. This first cut is the working MVP.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface FreeTransform {
  xPct: number;
  yPct: number;
  scalePct: number;
  rotationDeg: number;
}

interface TransformOverlayProps {
  /** Ref to the element the Player is rendered INTO. The overlay
   *  positions itself over this element and measures its size for
   *  the canvas-rect computation. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Current transform of the selected shot. When null, the overlay
   *  renders nothing (no selection). */
  transform: FreeTransform | null;
  /** Fire on every pointermove during a drag (live update). The parent
   *  pushes the value into state so the Remotion Player reflects the
   *  drag in real time. */
  onChange: (next: FreeTransform) => void;
  /** Fire once on pointerup with the final transform. The parent
   *  dispatches PATCH_ROW so the change lands on the undo stack and
   *  the autosave picks it up. */
  onCommit: (next: FreeTransform) => void;
}

type ActiveDrag =
  | null
  | { kind: 'body'; startX: number; startY: number; startXPct: number; startYPct: number }
  | { kind: 'corner'; anchorX: number; anchorY: number; startScalePct: number; startDistance: number };

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const CANVAS_ASPECT = CANVAS_W / CANVAS_H;

interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Compute the contained 16:9 rect inside the player container. */
function computeCanvasRect(el: HTMLElement | null): CanvasRect | null {
  if (!el) return null;
  const { width: cw, height: ch } = el.getBoundingClientRect();
  if (cw === 0 || ch === 0) return null;
  let width = cw;
  let height = cw / CANVAS_ASPECT;
  if (height > ch) {
    height = ch;
    width = ch * CANVAS_ASPECT;
  }
  return {
    left: (cw - width) / 2,
    top: (ch - height) / 2,
    width,
    height,
  };
}

export function TransformOverlay({
  containerRef,
  transform,
  onChange,
  onCommit,
}: TransformOverlayProps): React.ReactElement | null {
  const [canvasRect, setCanvasRect] = useState<CanvasRect | null>(null);

  // Re-measure the canvas rect on container resize + on mount. Keeps
  // the overlay's selection box pinned to the actual letterboxed
  // canvas even as the user resizes the editor panel.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasRect(computeCanvasRect(el));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Live drag state lives in a ref so the pointermove handler can read
  // the at-pointerdown snapshot without re-creating itself on every
  // intermediate transform update.
  const activeRef = useRef<ActiveDrag>(null);
  const transformRef = useRef<FreeTransform | null>(transform);
  transformRef.current = transform;

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const active = activeRef.current;
      const rect = canvasRect;
      if (!active || !rect || !transformRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      // Pointer position relative to the canvas top-left (in canvas
      // screen pixels), then convert to canvas-relative coords.
      const px = e.clientX - containerRect.left - rect.left;
      const py = e.clientY - containerRect.top - rect.top;
      if (active.kind === 'body') {
        const deltaX = e.clientX - active.startX;
        const deltaY = e.clientY - active.startY;
        // Convert pixel delta to percent of canvas (resolution-
        // independent so the move math is correct regardless of how
        // the editor panel is sized).
        const deltaXPct = (deltaX / rect.width) * 100;
        const deltaYPct = (deltaY / rect.height) * 100;
        const nextX = clamp(active.startXPct + deltaXPct, -200, 200);
        const nextY = clamp(active.startYPct + deltaYPct, -200, 200);
        onChange({ ...transformRef.current, xPct: nextX, yPct: nextY });
      } else if (active.kind === 'corner') {
        // Distance from the anchor (opposite corner) in canvas pixels.
        const distance = Math.hypot(px - active.anchorX, py - active.anchorY);
        const ratio = distance / Math.max(1, active.startDistance);
        const next = clamp(active.startScalePct * ratio, 10, 400);
        onChange({ ...transformRef.current, scalePct: next });
      }
    },
    [canvasRect, containerRef, onChange],
  );

  const handlePointerUp = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    document.removeEventListener('pointercancel', handlePointerUp);
    if (transformRef.current) {
      console.info('[editor transform overlay] drag-end', {
        kind: active.kind,
        final: transformRef.current,
      });
      onCommit(transformRef.current);
    }
  }, [handlePointerMove, onCommit]);

  // Cleanup on unmount: drop the document-level listeners if a drag
  // was in flight when the overlay unmounted (e.g. selection cleared).
  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  if (!transform || !canvasRect) return null;

  // Compute the selection box screen rect from the current transform.
  // Selection box represents the visual's bounding box AFTER scale,
  // centered at the offset position. The visual fills the canvas at
  // scale=100, so box = canvas × scale.
  const boxW = canvasRect.width * (transform.scalePct / 100);
  const boxH = canvasRect.height * (transform.scalePct / 100);
  const centerX = canvasRect.left + canvasRect.width / 2 + (transform.xPct / 100) * canvasRect.width;
  const centerY = canvasRect.top + canvasRect.height / 2 + (transform.yPct / 100) * canvasRect.height;
  const boxLeft = centerX - boxW / 2;
  const boxTop = centerY - boxH / 2;

  const onBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    activeRef.current = {
      kind: 'body',
      startX: e.clientX,
      startY: e.clientY,
      startXPct: transform.xPct,
      startYPct: transform.yPct,
    };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    console.info('[editor transform overlay] drag-start', {
      kind: 'body',
      from: transform,
    });
  };

  // Each corner anchors to the OPPOSITE corner so scaling pivots
  // around that fixed point — same behaviour Canva / Figma use.
  type CornerId = 'tl' | 'tr' | 'bl' | 'br';
  const onCornerPointerDown = (corner: CornerId) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!canvasRect) return;
    // Anchor corner in canvas-relative pixels (NOT screen pixels) —
    // matches the math in pointermove which works in the same space.
    const ax = corner === 'tr' || corner === 'br' ? boxLeft - canvasRect.left : boxLeft + boxW - canvasRect.left;
    const ay = corner === 'bl' || corner === 'br' ? boxTop - canvasRect.top : boxTop + boxH - canvasRect.top;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const px = e.clientX - containerRect.left - canvasRect.left;
    const py = e.clientY - containerRect.top - canvasRect.top;
    const startDistance = Math.hypot(px - ax, py - ay);
    activeRef.current = {
      kind: 'corner',
      anchorX: ax,
      anchorY: ay,
      startScalePct: transform.scalePct,
      startDistance,
    };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    console.info('[editor transform overlay] drag-start', {
      kind: 'corner',
      corner,
      from: transform,
    });
  };

  const HANDLE_SIZE = 12;
  const accent = 'var(--editor-accent, #a78bfa)';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
      }}
      aria-hidden
    >
      {/* Selection body — captures pointerdown for the move drag. */}
      <div
        onPointerDown={onBodyPointerDown}
        style={{
          position: 'absolute',
          left: boxLeft,
          top: boxTop,
          width: boxW,
          height: boxH,
          border: `1.5px dashed ${accent}`,
          cursor: 'move',
          pointerEvents: 'auto',
          background: 'transparent',
          boxSizing: 'border-box',
        }}
        title="Drag to move. Use corner handles to resize."
      />
      {/* Corner handles — aspect-locked scaling. */}
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => {
        const hx =
          corner === 'tl' || corner === 'bl'
            ? boxLeft - HANDLE_SIZE / 2
            : boxLeft + boxW - HANDLE_SIZE / 2;
        const hy =
          corner === 'tl' || corner === 'tr'
            ? boxTop - HANDLE_SIZE / 2
            : boxTop + boxH - HANDLE_SIZE / 2;
        return (
          <div
            key={corner}
            onPointerDown={onCornerPointerDown(corner)}
            style={{
              position: 'absolute',
              left: hx,
              top: hy,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              background: accent,
              border: '1.5px solid white',
              borderRadius: 2,
              cursor:
                corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize',
              pointerEvents: 'auto',
              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }}
            title="Drag to resize (aspect-locked)"
          />
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
