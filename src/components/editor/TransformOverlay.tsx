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
import { markGestureEnd, markGestureStart } from '@/lib/editor/gesture-state';

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
  /** Letterbox stripe height as a fraction of the canvas height (0-1).
   *  When > 0, the visual area starts BELOW the title stripe and the
   *  selection box is drawn around that smaller area. Defaults to 0
   *  (no stripe — visual fills the entire canvas). */
  stripeHeightFraction?: number;
  /** Fire on every pointermove during a drag (live update). The parent
   *  pushes the value into state so the Remotion Player reflects the
   *  drag in real time. */
  onChange: (next: FreeTransform) => void;
  /** Fire once on pointerup with the final transform. The parent
   *  dispatches PATCH_ROW so the change lands on the undo stack and
   *  the autosave picks it up. */
  onCommit: (next: FreeTransform) => void;
  /** Fire once on pointerdown when ANY drag begins (body, corner,
   *  rotate). The parent uses this to cancel any pending autosave so
   *  it can't fire mid-drag — a stale-version PATCH returning 409
   *  during the drag would trigger an auto-reload that wipes the
   *  drag state and the user perceives "drag doesn't work." */
  onGestureStart?: () => void;
}

type ActiveDrag =
  | null
  | { kind: 'body'; startX: number; startY: number; startXPct: number; startYPct: number }
  | { kind: 'corner'; anchorX: number; anchorY: number; startScalePct: number; startDistance: number }
  | { kind: 'rotate'; centerX: number; centerY: number; startAngle: number; startRotationDeg: number };

/** Snap-to-center / snap-to-edges threshold in canvas-relative
 *  percentage points. Drags closer than this snap; shift disables. */
const SNAP_THRESHOLD_PCT = 2;
/** Targets the body drag snaps to (canvas-relative x or y percent). */
const SNAP_TARGETS = [-50, -25, 0, 25, 50];

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
  stripeHeightFraction = 0,
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

  // Latest-value refs for everything the pointer handlers read. Without
  // these, `handlePointerMove` and `handlePointerUp` would close over
  // changing props/state (`onChange`, `onCommit`, `canvasRect`,
  // `stripeHeightFraction`) and re-create on every parent render. That
  // matters because the FIRST onChange dispatch fires a transient
  // PATCH_ROW which causes the parent to re-render synchronously after
  // the event handler — the cleanup `useEffect` below then sees its
  // deps change and removes the document-level listeners that
  // pointerdown JUST registered. Net result: drags die after one
  // pointermove (or before, if the parent re-rendered between
  // pointerdown and the first move for unrelated reasons — playhead
  // tick, autosave-status change, etc.) and the user perceives drag
  // and resize as completely broken. Routing everything through refs
  // lets the handlers stay stable for the lifetime of the component.
  const canvasRectRef = useRef(canvasRect);
  canvasRectRef.current = canvasRect;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const stripeHeightFractionRef = useRef(stripeHeightFraction);
  stripeHeightFractionRef.current = stripeHeightFraction;

  // Stable identity (empty deps). Reads everything off refs above so a
  // parent re-render mid-drag does not invalidate the listener that
  // pointerdown registered. See the long comment above for why this
  // matters.
  const handlePointerMove = useCallback((e: PointerEvent) => {
    const active = activeRef.current;
    const rect = canvasRectRef.current;
    if (!active || !rect || !transformRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    // The visual area is the canvas minus the top title stripe. The
    // renderer applies `translate(xPct%, yPct%)` against the visual
    // element which fills this area, so the overlay's delta math
    // must use these dimensions to keep mouse → screen mapping 1:1.
    const stripeFrac = stripeHeightFractionRef.current;
    const stripePxLocal = rect.height * Math.max(0, Math.min(1, stripeFrac));
    const visualW = rect.width;
    const visualH = rect.height - stripePxLocal;
    // Pointer position relative to the canvas top-left (in canvas
    // screen pixels), then convert to canvas-relative coords.
    const px = e.clientX - containerRect.left - rect.left;
    const py = e.clientY - containerRect.top - rect.top;
    if (active.kind === 'body') {
      const deltaX = e.clientX - active.startX;
      const deltaY = e.clientY - active.startY;
      // Convert pixel delta to percent of VISUAL AREA (matches what
      // the renderer translates by).
      const deltaXPct = (deltaX / visualW) * 100;
      const deltaYPct = (deltaY / visualH) * 100;
      let nextX = clamp(active.startXPct + deltaXPct, -200, 200);
      let nextY = clamp(active.startYPct + deltaYPct, -200, 200);
      // Snap to center / quarters / halves UNLESS:
      //   - shift held (user override)
      //   - the drag has barely moved (< 3% of canvas) — would
      //     snap back to the start position, making the drag feel
      //     stuck
      //   - the snap target IS the start value — same issue, the
      //     visual just refuses to leave its starting point until
      //     the cursor crosses the snap zone exit
      const movedEnough =
        Math.abs(deltaXPct) > 3 || Math.abs(deltaYPct) > 3;
      if (!e.shiftKey && movedEnough) {
        for (const t of SNAP_TARGETS) {
          if (
            Math.abs(nextX - t) < SNAP_THRESHOLD_PCT &&
            Math.abs(t - active.startXPct) > 1
          ) {
            nextX = t;
          }
          if (
            Math.abs(nextY - t) < SNAP_THRESHOLD_PCT &&
            Math.abs(t - active.startYPct) > 1
          ) {
            nextY = t;
          }
        }
      }
      onChangeRef.current({ ...transformRef.current, xPct: nextX, yPct: nextY });
    } else if (active.kind === 'corner') {
      // Distance from the anchor (opposite corner) in canvas pixels.
      const distance = Math.hypot(px - active.anchorX, py - active.anchorY);
      const ratio = distance / Math.max(1, active.startDistance);
      const next = clamp(active.startScalePct * ratio, 10, 400);
      onChangeRef.current({ ...transformRef.current, scalePct: next });
    } else if (active.kind === 'rotate') {
      // Compute angle of the pointer relative to the box center,
      // then offset by the at-pointerdown angle so the rotation
      // is relative to where the drag started.
      const angle =
        (Math.atan2(py - active.centerY, px - active.centerX) * 180) / Math.PI;
      const delta = angle - active.startAngle;
      let next = active.startRotationDeg + delta;
      // Snap to 15° increments unless shift held.
      if (!e.shiftKey) {
        const snapped = Math.round(next / 15) * 15;
        if (Math.abs(next - snapped) < 5) next = snapped;
      }
      // Wrap to [-180, 180] for storage cleanliness.
      next = ((next + 180) % 360 + 360) % 360 - 180;
      onChangeRef.current({ ...transformRef.current, rotationDeg: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePointerUp = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    document.removeEventListener('pointercancel', handlePointerUp);
    // Clear the gesture flag so the conflict handler can resume
    // auto-reloading. Pair with the markGestureStart in each
    // pointerdown handler — counter-based so a drag can't double-end
    // and drift the counter negative.
    markGestureEnd(`transform-${active.kind}`);
    if (transformRef.current) {
      console.info('[editor transform overlay] drag-end', {
        kind: active.kind,
        final: transformRef.current,
      });
      onCommitRef.current(transformRef.current);
    }
    // handlePointerMove is itself a stable useCallback (empty deps), so
    // referencing it here without listing it is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount: drop the document-level listeners if a drag
  // was in flight when the overlay unmounted (e.g. selection cleared).
  // Because handlePointerMove and handlePointerUp are stable, this
  // effect runs only on unmount.
  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  if (!transform || !canvasRect) return null;

  // Visual area = canvas minus the top title stripe (when present).
  // The renderer composes the scene below the stripe; the selection
  // box should match THAT area, not the full canvas. When no stripe
  // (default), visualArea === canvasRect.
  const stripePx = canvasRect.height * Math.max(0, Math.min(1, stripeHeightFraction));
  const visualLeft = canvasRect.left;
  const visualTop = canvasRect.top + stripePx;
  const visualWidth = canvasRect.width;
  const visualHeight = canvasRect.height - stripePx;

  // Compute the selection box screen rect from the current transform.
  // Selection box represents the visual's bounding box AFTER scale,
  // centered at the offset position. The visual fills the visualArea
  // at scale=100, so box = visualArea × scale.
  const boxW = visualWidth * (transform.scalePct / 100);
  const boxH = visualHeight * (transform.scalePct / 100);
  const centerX = visualLeft + visualWidth / 2 + (transform.xPct / 100) * visualWidth;
  const centerY = visualTop + visualHeight / 2 + (transform.yPct / 100) * visualHeight;
  const boxLeft = centerX - boxW / 2;
  const boxTop = centerY - boxH / 2;

  const onBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    markGestureStart('transform-body');
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

  const onRotatePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!canvasRect) return;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    // Center of the selection box, in canvas-relative pixel coords
    // (matching the pointermove math).
    const cx = boxLeft + boxW / 2 - canvasRect.left;
    const cy = boxTop + boxH / 2 - canvasRect.top;
    const px = e.clientX - containerRect.left - canvasRect.left;
    const py = e.clientY - containerRect.top - canvasRect.top;
    const startAngle = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
    markGestureStart('transform-rotate');
    activeRef.current = {
      kind: 'rotate',
      centerX: cx,
      centerY: cy,
      startAngle,
      startRotationDeg: transform.rotationDeg,
    };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    console.info('[editor transform overlay] drag-start', {
      kind: 'rotate',
      from: transform,
    });
  };

  // Keyboard nudges — arrow keys move 1 percent, shift+arrow moves 10.
  // Only fire when the selection body has focus to avoid stealing
  // global shortcuts. The body div has tabIndex=0 below.
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    const next = {
      ...transform,
      xPct: clamp(transform.xPct + dx, -200, 200),
      yPct: clamp(transform.yPct + dy, -200, 200),
    };
    onChange(next);
    onCommit(next);
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
    markGestureStart('transform-corner');
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
      {/* Snap guides — show only while a body drag is on a snap line.
          A vertical line at canvas-center x (xPct === 0) AND a
          horizontal line at canvas-center y (yPct === 0). Quarter and
          half snap lines render the same way when active. */}
      {activeRef.current?.kind === 'body' && SNAP_TARGETS.includes(transform.xPct) && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: visualLeft + visualWidth / 2 + (transform.xPct / 100) * visualWidth,
            top: visualTop,
            width: 1,
            height: visualHeight,
            background: accent,
            opacity: 0.6,
            pointerEvents: 'none',
          }}
        />
      )}
      {activeRef.current?.kind === 'body' && SNAP_TARGETS.includes(transform.yPct) && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: visualLeft,
            top: visualTop + visualHeight / 2 + (transform.yPct / 100) * visualHeight,
            width: visualWidth,
            height: 1,
            background: accent,
            opacity: 0.6,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Selection body — captures pointerdown for the move drag.
          tabIndex=0 lets it accept keyboard focus so arrow nudges work. */}
      <div
        tabIndex={0}
        onPointerDown={onBodyPointerDown}
        onKeyDown={onBodyKeyDown}
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
          outline: 'none',
          // Counter-rotate the selection's render so a rotated visual
          // shows a rotated box (and the rotation handle sits above
          // the visual's top edge, not the canvas-coord top).
          transform: `rotate(${transform.rotationDeg}deg)`,
          transformOrigin: 'center center',
        }}
        title="Drag to move. Arrow keys nudge (shift = 10×). Corner handles resize."
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
      {/* Rotation handle — small circle floating above the box top
          edge. Drag in a circular motion to rotate the visual. Snaps
          to 15° increments unless shift is held. */}
      <div
        onPointerDown={onRotatePointerDown}
        style={{
          position: 'absolute',
          left: boxLeft + boxW / 2 - HANDLE_SIZE / 2,
          top: boxTop - 28,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          background: 'white',
          border: `1.5px solid ${accent}`,
          borderRadius: '50%',
          cursor: 'grab',
          pointerEvents: 'auto',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}
        title="Drag in a circle to rotate (snaps to 15°; shift to free-rotate)"
      />
      {/* Tether line from the rotation handle to the box top edge. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: boxLeft + boxW / 2 - 0.5,
          top: boxTop - 28 + HANDLE_SIZE,
          width: 1,
          height: 28 - HANDLE_SIZE,
          background: accent,
          opacity: 0.6,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
