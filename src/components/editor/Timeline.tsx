'use client';

/**
 * Shot-graph editor — timeline strip.
 *
 * Phase 2 of `_plans/2026-05-18-shot-graph-editor.md`. Renders the
 * project's shots as cards laid out in playback order, widths
 * proportional to `durationMs`, with thumbnails + duration labels.
 *
 * Editing affordances implemented here:
 *   – click a card → select (dispatches SET_SELECTION)
 *   – drag trailing edge → resize (dispatches RESIZE_SHOT live during drag)
 *
 * Snap-to-frame happens at the data layer (the renderer's frame math
 * naturally quantises); the drag dispatches integer ms values, the
 * reducer clamps, the renderer rounds when converting to frames.
 *
 * Phase 2 follow-up commits layer their UI on top:
 *   – trim head / trim tail handles (additional small handles on hover)
 *   – split at playhead (button anchored to the playhead bar)
 *   – delete (context menu on the card)
 *   – reorder (`<SortableContext>` wraps the strip)
 *   – mute toggle (top-right of the card)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoConfig, VideoShot } from '@/remotion/types';
import { EDITOR_MAX_SHOT_MS, EDITOR_MIN_SHOT_MS } from '@/lib/editor/store';

interface TimelineProps {
  config: VideoConfig;
  /** Per-shot first-frame thumbnail URL, keyed by shot index. Falls
   *  back to a colored block when no image is present. */
  rowImages: Record<number, string>;
  /** Currently-selected shot index, or null. */
  selection: number | null;
  /** Current playhead position in ms from start of timeline. */
  playheadMs: number;
  /** Fired when a shot card is clicked. */
  onSelect: (shotIndex: number) => void;
  /** Fired live during a trailing-edge resize drag — and again on
   *  pointer-up with the final value. The store handles clamping +
   *  no-op detection, so calling this every pointermove is safe. */
  onResize?: (shotIndex: number, newDurationMs: number) => void;
  /** Optional: pixels per second. Default 80 — readable at standard
   *  shot lengths (4-15s). Phase 2 zoom controls bind this. */
  pixelsPerSecond?: number;
}

const DEFAULT_PX_PER_SECOND = 80;
const STRIP_HEIGHT = 96;
const MIN_CARD_WIDTH = 60;
/** Pixel width of the trailing-edge drag handle hot-zone. Large
 *  enough that mouse aim is forgiving, narrow enough not to cover
 *  the card's interior. */
const RESIZE_HANDLE_WIDTH = 8;

function formatMs(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  return `${Math.round(totalSeconds)}s`;
}

function shotLabel(shot: VideoShot, index: number): string {
  if (shot.title) return shot.title;
  if (shot.sectionTitle) return shot.sectionTitle;
  if (shot.onScreenText) return shot.onScreenText.slice(0, 40);
  if (shot.scriptText) return shot.scriptText.slice(0, 40);
  return `Shot ${index + 1}`;
}

interface DragState {
  shotIndex: number;
  /** Mouse X at pointerdown. */
  startClientX: number;
  /** Shot's durationMs at pointerdown. */
  startDurationMs: number;
  /** Live preview value used to render the tooltip and the resized
   *  card. Stored on the drag itself so re-renders driven by
   *  external state don't reset it. */
  previewMs: number;
}

export function Timeline({
  config,
  rowImages,
  selection,
  playheadMs,
  onSelect,
  onResize,
  pixelsPerSecond = DEFAULT_PX_PER_SECOND,
}: TimelineProps): React.ReactElement {
  const totalMs = useMemo(
    () => config.shots.reduce((acc, s) => acc + s.durationMs, 0),
    [config.shots],
  );
  const totalWidth = useMemo(
    () => Math.max(120, (totalMs / 1000) * pixelsPerSecond),
    [totalMs, pixelsPerSecond],
  );
  const playheadX = useMemo(
    () => Math.min((playheadMs / 1000) * pixelsPerSecond, totalWidth),
    [playheadMs, pixelsPerSecond, totalWidth],
  );

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  /** Convert a pixel delta to a ms delta at the current zoom level. */
  const pxToMs = useCallback(
    (px: number): number => (px / pixelsPerSecond) * 1000,
    [pixelsPerSecond],
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, shotIndex: number) => {
      if (!onResize) return;
      // Don't let the parent card's click handler fire — the user is
      // grabbing the handle, not selecting the shot.
      e.preventDefault();
      e.stopPropagation();
      const shot = config.shots[shotIndex];
      if (!shot) return;
      // Capture so subsequent move + up events route to this element
      // even if the cursor leaves the strip mid-drag.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({
        shotIndex,
        startClientX: e.clientX,
        startDurationMs: shot.durationMs,
        previewMs: shot.durationMs,
      });
    },
    [config.shots, onResize],
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      if (!current || !onResize) return;
      const deltaPx = e.clientX - current.startClientX;
      const naive = current.startDurationMs + pxToMs(deltaPx);
      const clamped = Math.min(EDITOR_MAX_SHOT_MS, Math.max(EDITOR_MIN_SHOT_MS, Math.round(naive)));
      // Snap to nearest frame at the displayed level (1000/fps ms).
      const fps = config.fps || 30;
      const frameStepMs = 1000 / fps;
      const snapped = Math.round(clamped / frameStepMs) * frameStepMs;
      setDrag({ ...current, previewMs: snapped });
      // Dispatch the new duration live so the renderer + cascade
      // update in real time. The store no-ops when the value is
      // unchanged, so this is safe to fire on every pointermove.
      if (snapped !== current.startDurationMs) {
        onResize(current.shotIndex, snapped);
      }
    },
    [config.fps, onResize, pxToMs],
  );

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      if (!current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      console.info('[editor timeline] resize complete', {
        shotIndex: current.shotIndex,
        from: current.startDurationMs,
        to: current.previewMs,
      });
      setDrag(null);
    },
    [],
  );

  // ESC cancels an in-progress drag — restores the original duration
  // and ends the drag without committing.
  useEffect(() => {
    if (!drag || !onResize) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onResize(drag.shotIndex, drag.startDurationMs);
        setDrag(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, onResize]);

  return (
    <div
      className="relative w-full overflow-x-auto overflow-y-hidden rounded-lg border"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--card-bg)',
      }}
    >
      <div
        className="relative flex items-stretch select-none"
        style={{
          width: totalWidth,
          height: STRIP_HEIGHT,
          minWidth: '100%',
        }}
      >
        {config.shots.map((shot, idx) => {
          const widthPx = Math.max(
            MIN_CARD_WIDTH,
            (shot.durationMs / 1000) * pixelsPerSecond,
          );
          const thumbnail = rowImages[idx] ?? shot.imageUrl ?? null;
          const isSelected = selection === idx;
          const isDragging = drag?.shotIndex === idx;
          const isLast = idx === config.shots.length - 1;
          return (
            <div
              key={idx}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(idx);
                }
              }}
              className="relative shrink-0 group focus:outline-none cursor-pointer"
              style={{
                width: widthPx,
                borderRight: isLast ? 'none' : '1px solid var(--card-border)',
              }}
              aria-pressed={isSelected}
              aria-label={`Shot ${idx + 1}: ${shotLabel(shot, idx)}`}
            >
              {thumbnail ? (
                <img
                  src={thumbnail}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <div
                  className="absolute inset-0"
                  style={{
                    background: shot.backgroundColor ?? '#111827',
                  }}
                />
              )}
              {/* Tinted overlay — keeps the label legible over any
                  thumbnail. Heavier when selected so the card pops. */}
              <div
                className="absolute inset-0 transition-colors pointer-events-none"
                style={{
                  background: isSelected
                    ? 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.35) 50%, rgba(99,102,241,0.25) 100%)'
                    : 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.15) 60%, transparent 100%)',
                }}
              />
              <div className="absolute inset-0 flex flex-col justify-between p-1.5 text-left pointer-events-none">
                <div className="flex items-center gap-1">
                  <span
                    className="text-[10px] font-semibold rounded px-1 py-0.5"
                    style={{
                      background: 'rgba(0,0,0,0.6)',
                      color: '#fff',
                    }}
                  >
                    {idx + 1}
                  </span>
                  {shot.muted && (
                    <span
                      className="text-[9px] rounded px-1 py-0.5"
                      style={{ background: 'rgba(220,38,38,0.7)', color: '#fff' }}
                      title="Audio muted on this shot"
                    >
                      mute
                    </span>
                  )}
                </div>
                <div>
                  <div
                    className="text-[10px] font-medium truncate"
                    style={{ color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
                    title={shotLabel(shot, idx)}
                  >
                    {shotLabel(shot, idx)}
                  </div>
                  <div
                    className="text-[10px] tabular-nums"
                    style={{ color: 'rgba(255,255,255,0.85)' }}
                  >
                    {isDragging && drag ? formatMs(drag.previewMs) : formatMs(shot.durationMs)}
                  </div>
                </div>
              </div>
              {isSelected && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    boxShadow: 'inset 0 0 0 2px var(--accent-purple-bright, #a78bfa)',
                  }}
                />
              )}

              {/* Trailing-edge resize handle. Reaches a few pixels
                  beyond the card boundary so the user can grab the
                  adjacent card's leading edge too — except on the
                  last card, where it sits flush. */}
              {onResize && (
                <div
                  className="absolute top-0 bottom-0 z-10 cursor-ew-resize transition-colors"
                  style={{
                    right: -RESIZE_HANDLE_WIDTH / 2,
                    width: RESIZE_HANDLE_WIDTH,
                    background: isDragging
                      ? 'rgba(167, 139, 250, 0.8)'
                      : 'transparent',
                  }}
                  onPointerDown={(e) => handleResizePointerDown(e, idx)}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={handleResizePointerUp}
                  onPointerCancel={handleResizePointerUp}
                  aria-hidden
                />
              )}

              {/* Drag tooltip — surfaces the live preview duration
                  above the card while dragging. Only renders during
                  this card's drag. */}
              {isDragging && drag && (
                <div
                  className="absolute -top-6 right-0 text-[10px] px-1.5 py-0.5 rounded tabular-nums"
                  style={{
                    background: 'rgba(0,0,0,0.85)',
                    color: '#fff',
                    transform: 'translateX(50%)',
                  }}
                >
                  {formatMs(drag.previewMs)}
                </div>
              )}
            </div>
          );
        })}

        {/* Playhead. Renders even when ms === 0 so the user has a
            visual anchor at the start of the strip. */}
        <div
          aria-hidden
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: playheadX,
            width: 2,
            background: 'rgb(239, 68, 68)',
            transform: 'translateX(-1px)',
          }}
        >
          <div
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full"
            style={{ background: 'rgb(239, 68, 68)' }}
          />
        </div>
      </div>
    </div>
  );
}
