'use client';

/**
 * Timeline minimap — Phase 4 of
 * `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
 *
 * A compact strip below the timeline lane stack that shows the WHOLE
 * project at a glance. One colored block per shot (purple-accent for
 * the active shot, dimmer for the rest), with a translucent viewport
 * rectangle on top marking the visible window the timeline is
 * currently scrolled to. The user can click anywhere in the strip to
 * center the timeline on that point, or drag the rectangle to pan
 * the timeline in real time.
 *
 * Long-project wrap: when the project exceeds the wrap threshold
 * (default 5 minutes, configurable in settings), the strip splits
 * into two stacked rows — first half on top, second half below. The
 * viewport rectangle is drawn on whichever row(s) the visible window
 * intersects; if the window straddles the midpoint, two rectangles
 * are drawn (one per row) and the drag moves both together. The
 * wrap is opt-out via `wrapEnabled`.
 *
 * Implementation notes:
 *   - The minimap subscribes to the timeline scroll container's
 *     scroll event so the rectangle tracks scrollLeft live without
 *     polling.
 *   - Click + drag math happens in "minimap pixel" coordinates and
 *     converts to ms via the lane's per-row pixel-per-ms scale.
 *   - The strip width is the parent's natural width (flex: 1) so
 *     the layout doesn't fight the timeline's column structure.
 *
 * The minimap is read-only beyond the pan affordance — clicking a
 * shot block does NOT seek (that's what the timeline lane is for).
 * Past plans considered "click block → select shot" but it
 * conflicted with the drag-to-pan gesture; kept out for now.
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { VideoShot } from '@/remotion/types';

interface TimelineMinimapProps {
  /** Every shot in the project. Used to draw per-block rectangles
   *  in start-order, widths proportional to durationMs. */
  shots: VideoShot[];
  /** Total project duration in ms. The minimap's full width maps
   *  exactly to this value. */
  totalDurationMs: number;
  /** Currently-selected shot index. Active block renders brighter. */
  selection: number | null;
  /** Whether the project's voiceover is attached. Drives whether we
   *  render the thin audio band under the shot blocks (no audio →
   *  no band). */
  hasAudio: boolean;
  /** The TimelineV2 scroll container ref. The minimap reads
   *  `scrollLeft` + `clientWidth` to draw the viewport rectangle
   *  and writes `scrollLeft` to pan on drag / click. */
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  /** Pixels-per-second the timeline is rendering at. Combined with
   *  totalDurationMs, this gives the timeline's full pixel width —
   *  the minimap converts scrollLeft to a ms position via this. */
  pixelsPerSecond: number;
  /** Strip total height in px. With wrap enabled + active, each row
   *  gets half this height. */
  height?: number;
  /** Threshold in minutes — projects ≥ this length wrap to two rows
   *  when wrapEnabled is also true. */
  wrapThresholdMinutes?: number;
  /** When false, the minimap stays single-row regardless of length. */
  wrapEnabled?: boolean;
}

const DEFAULT_HEIGHT_PX = 32;
const SHOT_BAND_FRACTION = 0.72; // top 72% of each row is the shot blocks
const AUDIO_BAND_FRACTION = 0.18; // bottom band reserved for audio cue

export function TimelineMinimap({
  shots,
  totalDurationMs,
  selection,
  hasAudio,
  scrollRef,
  pixelsPerSecond,
  height = DEFAULT_HEIGHT_PX,
  wrapThresholdMinutes = 5,
  wrapEnabled = true,
}: TimelineMinimapProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Re-render trigger for live scrollLeft tracking. Stored as state
  // rather than a ref so React re-paints the viewport rectangle on
  // every scroll tick. Cheap — just a number tick.
  const [scrollTick, setScrollTick] = useState(0);

  // Subscribe to the timeline's scroll event so we re-render when
  // the user scrolls the timeline (drag, wheel, keyboard, anything).
  // Also listen for resize on the scroll container so a window
  // resize updates the viewport rectangle's width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTick((n) => n + 1);
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [scrollRef]);

  const wraps =
    wrapEnabled && totalDurationMs > wrapThresholdMinutes * 60 * 1000;
  // Per-row duration in ms — single-row covers the whole project,
  // two-row covers half each.
  const rowDurationMs = wraps ? totalDurationMs / 2 : totalDurationMs;
  // We DO NOT use scrollTick inside this useMemo — it's only here so
  // the viewport rectangle re-derives below. Compute the shot blocks
  // separately (independent of scroll) so they don't re-allocate on
  // every scroll tick.
  const shotBlocks = useMemo(() => {
    if (shots.length === 0 || totalDurationMs <= 0) return [];
    let cursor = 0;
    return shots.map((shot, i) => {
      const startMs = cursor;
      cursor += shot.durationMs;
      return {
        index: i,
        startMs,
        durationMs: shot.durationMs,
      };
    });
  }, [shots, totalDurationMs]);

  // Viewport rectangle math — what's currently visible in the
  // timeline. ScrollLeft tells us the left edge; clientWidth tells
  // us how wide the visible window is. Convert px → ms via the
  // shared pixelsPerSecond.
  // Reads scrollRef.current each render (no stable ref subscription
  // exists for scrollLeft). We force re-renders via scrollTick so the
  // rectangle tracks live.
  const visible = (() => {
    const el = scrollRef.current;
    if (!el) return { startMs: 0, endMs: totalDurationMs };
    const startMs = (el.scrollLeft / pixelsPerSecond) * 1000;
    const endMs = ((el.scrollLeft + el.clientWidth) / pixelsPerSecond) * 1000;
    return {
      startMs: Math.max(0, startMs),
      endMs: Math.min(totalDurationMs, endMs),
    };
  })();
  // Suppress unused-var lint — scrollTick is used to trigger the
  // re-render that re-computes `visible` above.
  void scrollTick;

  // Pan the timeline so the given ms position is centered in the
  // visible window. Called by click + drag handlers.
  const panToMs = (targetMs: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const clampedMs = Math.max(0, Math.min(totalDurationMs, targetMs));
    const targetPx = (clampedMs / 1000) * pixelsPerSecond;
    const halfViewport = el.clientWidth / 2;
    el.scrollLeft = Math.max(0, targetPx - halfViewport);
  };

  // ─── Drag state ───────────────────────────────────────────────
  // Track whether the user is mid-drag on the viewport rectangle.
  // We use ref + pointer capture so the drag survives the mouse
  // wandering outside the minimap during a fast pan.
  const draggingRef = useRef<{
    pointerId: number;
    initialScrollLeft: number;
    initialClientX: number;
    rowDurationMs: number;
    rowWidthPx: number;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only — right-click stays available for browser
    // context menu (not blocked yet on the minimap).
    if (e.button !== 0) return;
    const container = containerRef.current;
    const scrollEl = scrollRef.current;
    if (!container || !scrollEl) return;
    const containerRect = container.getBoundingClientRect();
    const rowHeight = wraps ? height / 2 : height;
    const rowWidthPx = containerRect.width;

    // Which row of the minimap was clicked? In wrap mode, top row
    // is the first half of the project; bottom row is the second
    // half.
    const yInContainer = e.clientY - containerRect.top;
    const clickedRow = wraps && yInContainer >= rowHeight ? 1 : 0;
    const rowOffsetMs = clickedRow * rowDurationMs;

    // Which ms within this row was clicked?
    const xInContainer = e.clientX - containerRect.left;
    const fractionWithinRow = Math.max(
      0,
      Math.min(1, xInContainer / rowWidthPx),
    );
    const clickedMs = rowOffsetMs + fractionWithinRow * rowDurationMs;

    // Decide: is the user clicking the viewport rectangle (start drag)
    // or clicking somewhere else (jump-to)? We compare the clicked ms
    // against the visible range — clicking INSIDE the range starts
    // a drag; clicking outside jumps the viewport.
    const insideViewport =
      clickedMs >= visible.startMs && clickedMs <= visible.endMs;
    if (insideViewport) {
      // Start drag — capture pointer + record initial offsets.
      container.setPointerCapture(e.pointerId);
      draggingRef.current = {
        pointerId: e.pointerId,
        initialScrollLeft: scrollEl.scrollLeft,
        initialClientX: e.clientX,
        rowDurationMs,
        rowWidthPx,
      };
      console.info('[editor minimap] drag-start', {
        atMs: clickedMs,
        scrollLeft: scrollEl.scrollLeft,
      });
    } else {
      // Jump — center the viewport on the clicked position.
      console.info('[editor minimap] click-jump', {
        toMs: clickedMs,
        prevStart: visible.startMs,
      });
      panToMs(clickedMs);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    // Per-minimap-px → per-timeline-px ratio. In wrap mode each row
    // covers half the project, but each row is the FULL container
    // width — so a pixel of horizontal drag on the minimap moves
    // proportionally less in timeline ms when wrapped.
    const minimapPxToMs = drag.rowDurationMs / drag.rowWidthPx;
    const timelineMsToPx = pixelsPerSecond / 1000;
    const dxClient = e.clientX - drag.initialClientX;
    const dxTimelinePx = dxClient * minimapPxToMs * timelineMsToPx;
    scrollEl.scrollLeft = drag.initialScrollLeft + dxTimelinePx;
  };

  const handlePointerUp = () => {
    const drag = draggingRef.current;
    if (!drag) return;
    try {
      containerRef.current?.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released — pointercancel followed by pointerup.
    }
    const scrollEl = scrollRef.current;
    console.info('[editor minimap] drag-end', {
      finalScrollLeft: scrollEl?.scrollLeft ?? null,
    });
    draggingRef.current = null;
  };

  if (shots.length === 0 || totalDurationMs <= 0) return null;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="slider"
      aria-label="Timeline overview — drag the viewport rectangle to pan, click anywhere to jump"
      aria-valuemin={0}
      aria-valuemax={totalDurationMs}
      aria-valuenow={Math.round(visible.startMs)}
      style={{
        position: 'relative',
        height,
        width: '100%',
        background: 'var(--editor-bg-deep, #0a0c10)',
        borderTop: '1px solid var(--editor-edge)',
        cursor: 'pointer',
        touchAction: 'none',
        userSelect: 'none',
      }}
      title="Timeline overview"
    >
      {/* Row(s). Each row is a horizontal band covering its share
          of the project. Shot blocks + audio band paint here. */}
      {(wraps ? [0, 1] : [0]).map((rowIdx) => {
        const rowTopFraction = rowIdx / (wraps ? 2 : 1);
        const rowHeightFraction = 1 / (wraps ? 2 : 1);
        const rowStartMs = rowIdx * rowDurationMs;
        const rowEndMs = rowStartMs + rowDurationMs;
        return (
          <div
            key={rowIdx}
            style={{
              position: 'absolute',
              top: `${rowTopFraction * 100}%`,
              height: `${rowHeightFraction * 100}%`,
              left: 0,
              right: 0,
              borderBottom:
                wraps && rowIdx === 0
                  ? '1px solid var(--editor-edge)'
                  : 'none',
            }}
          >
            {/* Shot blocks. Each block's width is the fraction of the
                row's duration its shot occupies. Active selection
                renders at full accent color. */}
            {shotBlocks
              .filter(
                (b) =>
                  b.startMs < rowEndMs &&
                  b.startMs + b.durationMs > rowStartMs,
              )
              .map((b) => {
                // Clip the block to this row's [rowStartMs, rowEndMs).
                const localStart = Math.max(0, b.startMs - rowStartMs);
                const localEnd = Math.min(
                  rowDurationMs,
                  b.startMs + b.durationMs - rowStartMs,
                );
                const leftPct = (localStart / rowDurationMs) * 100;
                const widthPct = ((localEnd - localStart) / rowDurationMs) * 100;
                const isActive = selection === b.index;
                return (
                  <div
                    key={b.index}
                    style={{
                      position: 'absolute',
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: '8%',
                      height: `${SHOT_BAND_FRACTION * 100}%`,
                      background: isActive
                        ? 'var(--editor-accent)'
                        : 'rgba(167, 139, 250, 0.32)',
                      borderRight: '1px solid rgba(0,0,0,0.4)',
                    }}
                  />
                );
              })}
            {/* Audio band — thin cyan stripe under the shot blocks
                to confirm "yes, audio runs through here". Only when
                the project has a voiceover attached. */}
            {hasAudio && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: '4%',
                  height: `${AUDIO_BAND_FRACTION * 100}%`,
                  background: 'rgba(34, 211, 238, 0.45)',
                  borderRadius: 1,
                }}
              />
            )}
            {/* Viewport rectangle for THIS row — drawn only when the
                visible window intersects the row's [rowStartMs,
                rowEndMs) range. In wrap mode, a visible window that
                straddles the midpoint draws TWO rectangles (one per
                row), and the drag-to-pan code moves them together. */}
            {visible.endMs > rowStartMs && visible.startMs < rowEndMs && (
              <div
                style={{
                  position: 'absolute',
                  left: `${(Math.max(0, visible.startMs - rowStartMs) / rowDurationMs) * 100}%`,
                  width: `${((Math.min(rowDurationMs, visible.endMs - rowStartMs) - Math.max(0, visible.startMs - rowStartMs)) / rowDurationMs) * 100}%`,
                  top: 0,
                  bottom: 0,
                  background: 'rgba(167, 139, 250, 0.16)',
                  border: '1px solid var(--editor-accent)',
                  pointerEvents: 'none',
                  boxSizing: 'border-box',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
