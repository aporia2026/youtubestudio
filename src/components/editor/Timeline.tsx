'use client';

/**
 * Shot-graph editor — timeline strip.
 *
 * Phase 2 of `_plans/2026-05-18-shot-graph-editor.md`. Renders the
 * project's shots as cards laid out in playback order, widths
 * proportional to `durationMs`, with thumbnails + duration labels.
 *
 * Editing affordances:
 *   – click a card → select (dispatches SET_SELECTION)
 *   – drag trailing edge → resize (dispatches RESIZE_SHOT live)
 *   – drag the grab handle (top of card) → reorder shots
 *     (dispatches REORDER_SHOTS on drop)
 *
 * The three drag/click zones don't overlap: the grab handle owns
 * the top 14 px of each card, the resize handle owns the rightmost
 * 8 px, and click-to-select fires on the interior. ESC during a
 * resize drag cancels; @dnd-kit's KeyboardSensor handles ESC during
 * a reorder drag automatically.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { VideoConfig, VideoShot } from '@/remotion/types';
import type { ProductionDoc } from '@/remotion/utils';
import { EDITOR_MAX_SHOT_MS, EDITOR_MIN_SHOT_MS } from '@/lib/editor/store';
import { MotionCollageThumb } from '@/components/editor/MotionCollageThumb';
import { TitleCardThumb } from '@/components/editor/TitleCardThumb';
import { ShotKindBadge } from '@/components/editor/ShotKindBadge';
import { InsertSceneAffordance } from './InsertSceneAffordance';
import { formatTimecode } from './SetTimingPopover';

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
  /** Fired live during a LEADING-edge resize drag. Dispatches a
   *  `SET_SHOT_TIMING { shotIndex, startMs: newStartMs, endMs:
   *  unchanged }` against the store, which carves from / gives back
   *  to the left neighbor in a single atomic step. Each pointermove
   *  fires, mirroring `onResize`'s live-dispatch pattern. See
   *  `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`. */
  onLeadingResize?: (shotIndex: number, newStartMs: number) => void;
  /** Fired on drag-end with the source and target indices. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Fired live during a trim drag (head OR tail) — and again on
   *  pointer-up with the final value. `null` for either field means
   *  "clear it"; `undefined` means "leave it alone". */
  onTrim?: (
    shotIndex: number,
    values: { trimStartMs?: number | null; trimEndMs?: number | null },
  ) => void;
  /** Read the row's current trim_start_ms / trim_end_ms so the
   *  handles draw at the right offset from the card edges. Keyed by
   *  shot index, both in ms. */
  rowTrims?: Record<number, { trimStartMs?: number; trimEndMs?: number }>;
  /** Fired when the user toggles the cross-fade transition into a
   *  shot. Pass `null` to clear back to the doc default. */
  onToggleTransition?: (shotIndex: number, transition: 'cross-fade' | null) => void;
  /** Per-shot transition_in values (`'cross-fade' | null | undefined`)
   *  read from the doc rows. Keyed by shot index. */
  rowTransitions?: Record<number, 'cross-fade' | null | undefined>;
  /** Optional: pixels per second. Default 80 — readable at standard
   *  shot lengths (4-15s). Phase 2 zoom controls bind this. */
  pixelsPerSecond?: number;
  /** Index of the shot the playhead is currently inside, when a split
   *  there would produce two legal halves (both ≥ EDITOR_MIN_SHOT_MS).
   *  Null when no shot is splittable right now (playhead at a seam,
   *  inside a too-short shot, etc.). The card at this index shows a
   *  scissors button at the playhead X when it's also selected. See
   *  `_plans/2026-06-02-shot-split-ui.md`. */
  splitAvailableShotIndex?: number | null;
  /** Fires when the user clicks the scissors button on the selected
   *  card. The parent dispatches `SPLIT_SHOT` with the playhead's
   *  shotIndex + offset. */
  onSplit?: () => void;
  /** Phase 3 of the editor timeline-and-shots overhaul plan. Fires
   *  on right-click of a shot card with the viewport coords so the
   *  parent (EditorClient) can open its centralized context menu.
   *  When omitted, native browser context menu shows up — kept
   *  optional so callers that don't want the menu (e.g. story-book
   *  fixtures) don't have to pass anything. */
  onShotContextMenu?: (shotIndex: number, x: number, y: number) => void;
  /** Fires when the user clicks "+" between two cards (or before the
   *  first / after the last) and picks an insert mode. The parent
   *  dispatches `INSERT_BLANK_SHOT { atIndex, mode, durationMs,
   *  carveFrom }`. When omitted, the seam "+" affordances aren't
   *  rendered. See
   *  `_plans/2026-05-23-editor-insert-blank-scene-between.md`. */
  onInsertScene?: (
    atIndex: number,
    mode: 'carve' | 'shift',
    carveFrom?: 'left' | 'right' | 'auto',
  ) => void;
  /** Default duration (ms) for a newly-inserted blank scene. From the
   *  user's editor settings; the affordance shows this in its button
   *  labels so the user sees what they'll get. Falls back to
   *  `EDITOR_MIN_SHOT_MS` when not provided. */
  insertSceneDefaultDurationMs?: number;
}

const DEFAULT_PX_PER_SECOND = 80;
const STRIP_HEIGHT = 96;
const MIN_CARD_WIDTH = 60;
/** Pixel width of the trailing-edge drag handle hot-zone. */
const RESIZE_HANDLE_WIDTH = 8;
/** Pixel height of the grab-handle bar at the top of each card. */
const GRAB_HANDLE_HEIGHT = 14;
/** Pixel width of the head / tail trim handle hot-zones. Sit
 *  INSIDE the card (vs the resize handle which sits on the boundary)
 *  so they don't fight each other for pointer events. */
const TRIM_HANDLE_WIDTH = 6;

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

interface ResizeDragState {
  shotIndex: number;
  startClientX: number;
  startDurationMs: number;
  previewMs: number;
}

interface LeadingResizeDragState {
  shotIndex: number;
  startClientX: number;
  /** The shot's startMs at the moment the drag began (cascade-derived
   *  from preceding durations). The drag computes the new startMs
   *  as `startStartMs + pxToMs(deltaPx)` and dispatches it via
   *  `onLeadingResize`. */
  startStartMs: number;
  /** The shot's endMs at the drag start — held constant for the entire
   *  drag, so each dispatch sets `startMs` only. */
  endMs: number;
  /** Live preview value the card uses for its tooltip. */
  previewStartMs: number;
}

type TrimSide = 'head' | 'tail';

interface TrimDragState {
  shotIndex: number;
  side: TrimSide;
  startClientX: number;
  /** The trim value (in ms) at the moment the drag began. */
  startTrimMs: number;
  /** Live preview value the card uses to render its overlay. */
  previewMs: number;
}

export function Timeline({
  config,
  rowImages,
  selection,
  playheadMs,
  onSelect,
  onResize,
  onLeadingResize,
  onReorder,
  onTrim,
  rowTrims,
  onToggleTransition,
  rowTransitions,
  pixelsPerSecond = DEFAULT_PX_PER_SECOND,
  onShotContextMenu,
  onInsertScene,
  insertSceneDefaultDurationMs = EDITOR_MIN_SHOT_MS,
  splitAvailableShotIndex = null,
  onSplit,
}: TimelineProps): React.ReactElement {
  const totalMs = useMemo(
    () => config.shots.reduce((acc, s) => acc + s.durationMs, 0),
    [config.shots],
  );
  const totalWidth = useMemo(
    () => Math.max(120, (totalMs / 1000) * pixelsPerSecond),
    [totalMs, pixelsPerSecond],
  );
  /** Pixel offsets of every seam between shots, plus the start (0)
   *  and end (totalWidth). Same widthPx formula the cards use so the
   *  seam markers line up exactly with the card edges. Length =
   *  shots.length + 1: index 0 = before-first, index N = after-last. */
  const seamXs = useMemo(() => {
    const xs: number[] = [0];
    let cumulative = 0;
    for (const shot of config.shots) {
      const widthPx = Math.max(
        MIN_CARD_WIDTH,
        (shot.durationMs / 1000) * pixelsPerSecond,
      );
      cumulative += widthPx;
      xs.push(cumulative);
    }
    return xs;
  }, [config.shots, pixelsPerSecond]);
  /** Cumulative start time (ms) of every shot. Used by the leading-
   *  edge drag handler to feed `onLeadingResize` the absolute startMs
   *  the reducer expects. Length = shots.length. */
  const shotStartTimesMs = useMemo(() => {
    const out: number[] = [];
    let cumulative = 0;
    for (const shot of config.shots) {
      out.push(cumulative);
      cumulative += shot.durationMs;
    }
    return out;
  }, [config.shots]);
  const playheadX = useMemo(
    () => Math.min((playheadMs / 1000) * pixelsPerSecond, totalWidth),
    [playheadMs, pixelsPerSecond, totalWidth],
  );

  const [resize, setResize] = useState<ResizeDragState | null>(null);
  const resizeRef = useRef<ResizeDragState | null>(null);
  resizeRef.current = resize;

  const [leadingResize, setLeadingResize] = useState<LeadingResizeDragState | null>(null);
  const leadingResizeRef = useRef<LeadingResizeDragState | null>(null);
  leadingResizeRef.current = leadingResize;

  const [trim, setTrim] = useState<TrimDragState | null>(null);
  const trimRef = useRef<TrimDragState | null>(null);
  trimRef.current = trim;

  /** Convert a pixel delta to a ms delta at the current zoom level. */
  const pxToMs = useCallback(
    (px: number): number => (px / pixelsPerSecond) * 1000,
    [pixelsPerSecond],
  );

  // ─── Resize-handle pointer events ──────────────────────────────

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, shotIndex: number) => {
      if (!onResize) return;
      e.preventDefault();
      e.stopPropagation();
      const shot = config.shots[shotIndex];
      if (!shot) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setResize({
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
      const current = resizeRef.current;
      if (!current || !onResize) return;
      const deltaPx = e.clientX - current.startClientX;
      const naive = current.startDurationMs + pxToMs(deltaPx);
      const clamped = Math.min(EDITOR_MAX_SHOT_MS, Math.max(EDITOR_MIN_SHOT_MS, Math.round(naive)));
      const fps = config.fps || 30;
      const frameStepMs = 1000 / fps;
      const snapped = Math.round(clamped / frameStepMs) * frameStepMs;
      setResize({ ...current, previewMs: snapped });
      if (snapped !== current.startDurationMs) {
        onResize(current.shotIndex, snapped);
      }
    },
    [config.fps, onResize, pxToMs],
  );

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = resizeRef.current;
      if (!current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      console.info('[editor timeline] resize complete', {
        shotIndex: current.shotIndex,
        from: current.startDurationMs,
        to: current.previewMs,
      });
      setResize(null);
    },
    [],
  );

  // ESC cancels an in-progress resize.
  useEffect(() => {
    if (!resize || !onResize) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onResize(resize.shotIndex, resize.startDurationMs);
        setResize(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resize, onResize]);

  // ─── Leading-edge resize pointer events ────────────────────────
  //
  // Mirrors the trailing-edge handlers above but drives the start
  // (not the duration) — the reducer carves from the left neighbor
  // and resizes this shot in a single atomic SET_SHOT_TIMING command.

  const handleLeadingResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, shotIndex: number) => {
      if (!onLeadingResize) return;
      // First shot has no left neighbor — silently ignore.
      if (shotIndex === 0) return;
      const shot = config.shots[shotIndex];
      if (!shot) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const startStartMs = shotStartTimesMs[shotIndex] ?? 0;
      setLeadingResize({
        shotIndex,
        startClientX: e.clientX,
        startStartMs,
        endMs: startStartMs + shot.durationMs,
        previewStartMs: startStartMs,
      });
    },
    [config.shots, onLeadingResize, shotStartTimesMs],
  );

  const handleLeadingResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = leadingResizeRef.current;
      if (!current || !onLeadingResize) return;
      const deltaPx = e.clientX - current.startClientX;
      const naive = current.startStartMs + pxToMs(deltaPx);
      // Clamp the start to [0, endMs - MIN] so the live preview
      // never crosses the trailing edge (reducer enforces too, but
      // pre-clamping gives a snappier visual).
      const clamped = Math.min(
        current.endMs - EDITOR_MIN_SHOT_MS,
        Math.max(0, Math.round(naive)),
      );
      // Snap to frame boundaries for precision drag (matches the
      // trailing-edge resize snap).
      const fps = config.fps || 30;
      const frameStepMs = 1000 / fps;
      const snapped = Math.round(clamped / frameStepMs) * frameStepMs;
      setLeadingResize({ ...current, previewStartMs: snapped });
      if (snapped !== current.startStartMs) {
        onLeadingResize(current.shotIndex, snapped);
      }
    },
    [config.fps, onLeadingResize, pxToMs],
  );

  const handleLeadingResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = leadingResizeRef.current;
      if (!current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      console.info('[editor timeline] leading-resize complete', {
        shotIndex: current.shotIndex,
        from: current.startStartMs,
        to: current.previewStartMs,
      });
      setLeadingResize(null);
    },
    [],
  );

  // ESC cancels an in-progress leading-edge resize — restores the
  // original start.
  useEffect(() => {
    if (!leadingResize || !onLeadingResize) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onLeadingResize(leadingResize.shotIndex, leadingResize.startStartMs);
        setLeadingResize(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leadingResize, onLeadingResize]);

  // ─── Trim-handle pointer events ────────────────────────────────

  const handleTrimPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, shotIndex: number, side: TrimSide) => {
      if (!onTrim) return;
      e.preventDefault();
      e.stopPropagation();
      const currentTrim = rowTrims?.[shotIndex] ?? {};
      const startTrimMs =
        side === 'head'
          ? (currentTrim.trimStartMs ?? 0)
          : (currentTrim.trimEndMs ?? 0);
      e.currentTarget.setPointerCapture(e.pointerId);
      setTrim({
        shotIndex,
        side,
        startClientX: e.clientX,
        startTrimMs,
        previewMs: startTrimMs,
      });
    },
    [onTrim, rowTrims],
  );

  const handleTrimPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = trimRef.current;
      if (!current || !onTrim) return;
      const deltaPx = e.clientX - current.startClientX;
      // Head trim: dragging right (positive delta) INCREASES the
      // trim (we skip more from the start). Tail trim: dragging
      // LEFT (negative delta) increases the trim (we drop more from
      // the end). Both directions floor at 0.
      const direction: 1 | -1 = current.side === 'head' ? 1 : -1;
      const naive = current.startTrimMs + direction * pxToMs(deltaPx);
      const clamped = Math.max(0, Math.min(EDITOR_MAX_SHOT_MS, Math.round(naive)));
      setTrim({ ...current, previewMs: clamped });
      if (clamped !== current.startTrimMs) {
        if (current.side === 'head') {
          onTrim(current.shotIndex, { trimStartMs: clamped === 0 ? null : clamped });
        } else {
          onTrim(current.shotIndex, { trimEndMs: clamped === 0 ? null : clamped });
        }
      }
    },
    [onTrim, pxToMs],
  );

  const handleTrimPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = trimRef.current;
      if (!current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      console.info('[editor timeline] trim complete', {
        shotIndex: current.shotIndex,
        side: current.side,
        from: current.startTrimMs,
        to: current.previewMs,
      });
      setTrim(null);
    },
    [],
  );

  // ESC cancels an in-progress trim — restores the original value.
  useEffect(() => {
    if (!trim || !onTrim) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const restore = trim.startTrimMs === 0 ? null : trim.startTrimMs;
        onTrim(trim.shotIndex, trim.side === 'head' ? { trimStartMs: restore } : { trimEndMs: restore });
        setTrim(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trim, onTrim]);

  // ─── dnd-kit reorder wiring ─────────────────────────────────────

  // PointerSensor with a small activation distance so a quick click
  // on the grab handle (intending to start a click→select) doesn't
  // accidentally begin a drag. 4 px threshold matches dnd-kit's
  // recommended default for compact UI.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Stable sortable ids. Using `shot-N` ties the id to the current
  // position; on reorder dnd-kit looks them up against the
  // `items` array we pass to SortableContext.
  const sortableIds = useMemo(
    () => config.shots.map((_, i) => `shot-${i}`),
    [config.shots],
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (!onReorder) return;
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const fromIndex = sortableIds.indexOf(String(active.id));
      const toIndex = sortableIds.indexOf(String(over.id));
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      console.info('[editor timeline] reorder', { fromIndex, toIndex });
      onReorder(fromIndex, toIndex);
    },
    [onReorder, sortableIds],
  );

  return (
    <div
      className="relative w-full overflow-x-auto overflow-y-hidden rounded-lg border"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--card-bg)',
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
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
              const transitionIn = rowTransitions?.[idx];
              return (
                <SortableShotCard
                  key={sortableIds[idx]}
                  sortableId={sortableIds[idx]}
                  shot={shot}
                  index={idx}
                  widthPx={widthPx}
                  thumbnail={thumbnail}
                  isSelected={selection === idx}
                  isResizing={resize?.shotIndex === idx}
                  resizePreviewMs={resize?.shotIndex === idx ? resize.previewMs : null}
                  isLast={idx === config.shots.length - 1}
                  pixelsPerSecond={pixelsPerSecond}
                  trimStartMs={
                    trim?.shotIndex === idx && trim.side === 'head'
                      ? trim.previewMs
                      : rowTrims?.[idx]?.trimStartMs
                  }
                  trimEndMs={
                    trim?.shotIndex === idx && trim.side === 'tail'
                      ? trim.previewMs
                      : rowTrims?.[idx]?.trimEndMs
                  }
                  trimSideActive={trim?.shotIndex === idx ? trim.side : null}
                  onSelect={() => onSelect(idx)}
                  onResizePointerDown={
                    onResize ? (e) => handleResizePointerDown(e, idx) : undefined
                  }
                  onResizePointerMove={onResize ? handleResizePointerMove : undefined}
                  onResizePointerUp={onResize ? handleResizePointerUp : undefined}
                  isLeadingResizing={leadingResize?.shotIndex === idx}
                  leadingResizePreviewStartMs={
                    leadingResize?.shotIndex === idx ? leadingResize.previewStartMs : null
                  }
                  onLeadingResizePointerDown={
                    onLeadingResize && idx > 0
                      ? (e) => handleLeadingResizePointerDown(e, idx)
                      : undefined
                  }
                  onLeadingResizePointerMove={
                    onLeadingResize ? handleLeadingResizePointerMove : undefined
                  }
                  onLeadingResizePointerUp={
                    onLeadingResize ? handleLeadingResizePointerUp : undefined
                  }
                  onTrimPointerDown={
                    onTrim ? (e, side) => handleTrimPointerDown(e, idx, side) : undefined
                  }
                  onTrimPointerMove={onTrim ? handleTrimPointerMove : undefined}
                  onTrimPointerUp={onTrim ? handleTrimPointerUp : undefined}
                  reorderEnabled={Boolean(onReorder)}
                  transitionIn={transitionIn}
                  onToggleTransition={
                    onToggleTransition && idx > 0
                      ? () =>
                          onToggleTransition(
                            idx,
                            transitionIn === 'cross-fade' ? null : 'cross-fade',
                          )
                      : undefined
                  }
                  onContextMenu={
                    onShotContextMenu
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onShotContextMenu(idx, e.clientX, e.clientY);
                        }
                      : undefined
                  }
                  splitOffsetPx={
                    splitAvailableShotIndex === idx
                      ? Math.max(
                          0,
                          Math.min(
                            (shot.durationMs / 1000) * pixelsPerSecond,
                            ((playheadMs - shotStartTimesMs[idx]) / 1000) * pixelsPerSecond,
                          ),
                        )
                      : null
                  }
                  onSplit={onSplit}
                />
              );
            })}

            {/* Insert-scene seam affordances. One before card 0, one
                between every adjacent pair, one after the last card.
                Each is absolutely positioned at the seam X so the
                existing flex layout isn't perturbed. Rendered only when
                the parent wires onInsertScene. See
                `_plans/2026-05-23-editor-insert-blank-scene-between.md`. */}
            {onInsertScene &&
              seamXs.map((seamX, i) => (
                <InsertSceneAffordance
                  key={`insert-${i}`}
                  atIndex={i}
                  seamX={seamX}
                  height={STRIP_HEIGHT}
                  leftDurationMs={i > 0 ? config.shots[i - 1].durationMs : undefined}
                  rightDurationMs={
                    i < config.shots.length ? config.shots[i].durationMs : undefined
                  }
                  defaultDurationMs={insertSceneDefaultDurationMs}
                  minShotMs={EDITOR_MIN_SHOT_MS}
                  onInsert={(mode, carveFrom) => onInsertScene(i, mode, carveFrom)}
                />
              ))}

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
        </SortableContext>
      </DndContext>
    </div>
  );
}

// ─── Per-card sortable wrapper ──────────────────────────────────────

interface SortableShotCardProps {
  sortableId: string;
  shot: VideoShot;
  index: number;
  widthPx: number;
  thumbnail: string | null;
  isSelected: boolean;
  isResizing: boolean;
  resizePreviewMs: number | null;
  isLast: boolean;
  pixelsPerSecond: number;
  /** Current head-trim in ms (during a drag, the live preview value). */
  trimStartMs?: number;
  /** Current tail-trim in ms (during a drag, the live preview value). */
  trimEndMs?: number;
  /** Which trim side is being dragged on THIS card; null when no trim
   *  drag is active or it's on another card. Drives the tooltip
   *  position. */
  trimSideActive: TrimSide | null;
  onSelect: () => void;
  onResizePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizePointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizePointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** True when THIS card is the active leading-edge drag target.
   *  Drives the leading-edge handle's highlight + the live tooltip. */
  isLeadingResizing: boolean;
  /** Live preview startMs during the drag (cascade-derived). Null when
   *  no drag is active. Used for the leading-edge tooltip. */
  leadingResizePreviewStartMs: number | null;
  /** Leading-edge drag handlers. Undefined on the first card (start
   *  is anchored at 0; no left neighbor to carve from). */
  onLeadingResizePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLeadingResizePointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLeadingResizePointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTrimPointerDown?: (e: React.PointerEvent<HTMLDivElement>, side: TrimSide) => void;
  onTrimPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTrimPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  reorderEnabled: boolean;
  /** Per-shot transition_in. Drives the cross-fade chip rendered at
   *  the card's leading edge (skipped for the first card — no gap). */
  transitionIn: 'cross-fade' | null | undefined;
  /** Toggle handler. Undefined on the first card (nothing to fade
   *  in from) or when the editor doesn't wire onToggleTransition. */
  onToggleTransition?: () => void;
  /** Right-click handler. Optional — when omitted, the native browser
   *  context menu shows. */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Pixel offset from the card's left edge at which a SPLIT_SHOT
   *  would land (== playheadMs - cardStartMs, in pixels). Null when
   *  this card isn't the splittable target. The scissors button
   *  renders at this X when non-null AND the card is selected. */
  splitOffsetPx: number | null;
  /** Fires when the user clicks the scissors button. */
  onSplit?: () => void;
}

function SortableShotCard({
  sortableId,
  shot,
  index,
  widthPx,
  thumbnail,
  isSelected,
  isResizing,
  resizePreviewMs,
  isLast,
  pixelsPerSecond,
  trimStartMs,
  trimEndMs,
  trimSideActive,
  onSelect,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  isLeadingResizing,
  leadingResizePreviewStartMs,
  onLeadingResizePointerDown,
  onLeadingResizePointerMove,
  onLeadingResizePointerUp,
  onTrimPointerDown,
  onTrimPointerMove,
  onTrimPointerUp,
  reorderEnabled,
  transitionIn,
  onToggleTransition,
  onContextMenu,
  splitOffsetPx,
  onSplit,
}: SortableShotCardProps): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled: !reorderEnabled });

  // dnd-kit hands us a transform for the drag animation. Applied as
  // CSS transform so the card visibly follows the pointer without
  // dropping out of the strip's flex flow.
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    width: widthPx,
    borderRight: isLast ? 'none' : '1px solid var(--card-border)',
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative shrink-0 group focus:outline-none cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={isSelected}
      aria-label={`Shot ${index + 1}: ${shotLabel(shot, index)}`}
    >
      {thumbnail || (shot.motionCollagePanelUrls?.length ?? 0) > 0 ? (
        // Motion-collage shots render their N-panel grid inside the card
        // so they don't look like static shots. Falls through to a single
        // image (the regular thumbnail) for static shots — same render
        // shape as before. See
        // `_plans/2026-06-02-editor-motion-collage-support.md`.
        <MotionCollageThumb
          panelUrls={shot.motionCollagePanelUrls}
          grid={shot.motionCollageGrid}
          fallbackImageUrl={thumbnail}
          fillParent
          loading="lazy"
          shotIndex={index}
        />
      ) : shot.visualType === 'Title Card' ? (
        // Title card rows have no image but DO render typography via
        // TitleCardScene. Show a small typography preview so the card
        // doesn't masquerade as a broken / unfilled row (2026-06-02
        // user report). Mirrors the same fallback added to ShotsTab.
        <TitleCardThumb
          title={shot.title ?? shot.sectionTitle ?? 'Title card'}
          fillParent
        />
      ) : (
        // No image attached — render an obvious "blank shot" marker.
        // Repeating diagonal-stripe gradient + centered "BLANK" label
        // tells the user at a glance that this shot will render as
        // nothing (vs. assuming the card thumbnail is just slow).
        // 2026-05-24: addresses the "looked-like-a-render-bug-but-
        // shot-just-had-no-image" report from the user's NotPetya
        // project (shot 70 had visual_type='blank', no image_url).
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background:
              'repeating-linear-gradient(135deg, rgba(255,255,255,0.04) 0 8px, rgba(255,255,255,0.10) 8px 16px), #1f2937',
          }}
          aria-label="blank — no image"
        >
          <span
            className="uppercase tracking-widest font-semibold rounded px-1.5 py-0.5"
            style={{
              fontSize: 9,
              letterSpacing: '0.12em',
              background: 'rgba(0,0,0,0.55)',
              color: 'rgba(255,255,255,0.85)',
              pointerEvents: 'none',
            }}
          >
            blank
          </span>
        </div>
      )}
      {/* Shot-kind badge (top-left) + base/variant chip (top-right) —
          per-card glanceable indicators. Same data the inspector's
          Shot type dropdown shows, but visible on every card without
          clicking. User-asked-for 2026-06-02. */}
      <ShotKindBadge
        shotKind={shot.shotKind}
        visualType={shot.visualType}
        pinTopLeft
        scale="sm"
      />
      {shot.groupId && typeof shot.variantIndex === 'number' && (
        <span
          title={shot.variantIndex === 0 ? 'Base image of a variant group' : `Variant ${shot.variantIndex} of a base`}
          aria-label={shot.variantIndex === 0 ? 'Base image' : `Variant ${shot.variantIndex}`}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            zIndex: 1,
            padding: '1px 4px',
            fontSize: 9,
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: 0.2,
            borderRadius: 2,
            background:
              shot.variantIndex === 0
                ? 'rgba(167, 139, 250, 0.90)' // light purple — BASE
                : 'rgba(124, 58, 237, 0.90)', // deep purple — VAR
            color: '#fff',
            fontFamily: 'ui-monospace, monospace',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
            pointerEvents: 'none',
          }}
        >
          {shot.variantIndex === 0 ? 'BASE' : `V${shot.variantIndex}`}
        </span>
      )}
      {/* Tinted overlay — keeps the label legible over any thumbnail.
          Heavier when selected so the card pops. */}
      <div
        className="absolute inset-0 transition-colors pointer-events-none"
        style={{
          background: isSelected
            ? 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.35) 50%, rgba(99,102,241,0.25) 100%)'
            : 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.15) 60%, transparent 100%)',
        }}
      />
      <div className="absolute inset-0 flex flex-col justify-between p-1.5 pt-3 text-left pointer-events-none">
        <div className="flex items-center gap-1">
          <span
            className="text-[10px] font-semibold rounded px-1 py-0.5"
            style={{
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
            }}
          >
            {index + 1}
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
            title={shotLabel(shot, index)}
          >
            {shotLabel(shot, index)}
          </div>
          <div
            className="text-[10px] tabular-nums"
            style={{ color: 'rgba(255,255,255,0.85)' }}
          >
            {isResizing && resizePreviewMs !== null
              ? formatMs(resizePreviewMs)
              : formatMs(shot.durationMs)}
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

      {/* Grab handle for reorder. Top strip of the card. Owns the
          dnd-kit listeners so a drag on the interior does NOT start
          a reorder — that interior is reserved for click-to-select. */}
      {reorderEnabled && (
        <div
          {...attributes}
          {...listeners}
          className="absolute top-0 left-0 right-0 z-10 cursor-grab active:cursor-grabbing transition-colors"
          style={{
            height: GRAB_HANDLE_HEIGHT,
            background: isDragging
              ? 'rgba(167, 139, 250, 0.4)'
              : 'rgba(255, 255, 255, 0.08)',
          }}
          aria-label={`Drag to reorder shot ${index + 1}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] tracking-widest"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            ⋮⋮
          </div>
        </div>
      )}

      {/* Cross-fade transition chip on the card's leading edge.
          Sits half-inside / half-outside the card so it visually
          anchors to the gap between this shot and the previous
          shot. Hidden on the first card (no previous shot to fade
          from). When `transitionIn` is 'cross-fade' the chip is
          solid + filled; otherwise faded + outline-only and only
          visible on hover. Click toggles. */}
      {onToggleTransition && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleTransition();
          }}
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 rounded-full w-5 h-5 text-[10px] flex items-center justify-center transition-opacity ${
            transitionIn === 'cross-fade' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{
            left: 0,
            background:
              transitionIn === 'cross-fade' ? 'rgba(167, 139, 250, 0.95)' : 'rgba(0, 0, 0, 0.7)',
            color: transitionIn === 'cross-fade' ? '#000' : 'var(--accent-purple-bright, #a78bfa)',
            border:
              transitionIn === 'cross-fade'
                ? '1px solid rgba(167, 139, 250, 1)'
                : '1px solid var(--accent-purple-bright, #a78bfa)',
          }}
          title={
            transitionIn === 'cross-fade'
              ? 'Cross-fade in. Click to remove.'
              : 'Add a cross-fade in.'
          }
          aria-pressed={transitionIn === 'cross-fade'}
        >
          {transitionIn === 'cross-fade' ? '✕' : '+'}
        </button>
      )}

      {/* Head-trim overlay: a translucent strip over the
          first `trimStartMs` of the card, signalling that those
          frames are skipped at render time. */}
      {typeof trimStartMs === 'number' && trimStartMs > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: 0,
            width: Math.min(widthPx, (trimStartMs / 1000) * pixelsPerSecond),
            background:
              'repeating-linear-gradient(135deg, rgba(0,0,0,0.55) 0 6px, rgba(0,0,0,0.35) 6px 12px)',
          }}
          aria-hidden
        />
      )}
      {/* Tail-trim overlay: same idea, anchored on the right. */}
      {typeof trimEndMs === 'number' && trimEndMs > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            right: 0,
            width: Math.min(widthPx, (trimEndMs / 1000) * pixelsPerSecond),
            background:
              'repeating-linear-gradient(45deg, rgba(0,0,0,0.55) 0 6px, rgba(0,0,0,0.35) 6px 12px)',
          }}
          aria-hidden
        />
      )}

      {/* Head trim handle. Sits just inside the card's left edge so
          it doesn't fight the previous card's resize-handle (which
          overhangs by RESIZE_HANDLE_WIDTH/2 from the right). Only
          rendered when the parent wires `onTrim`. */}
      {onTrimPointerDown && (
        <div
          className="absolute top-0 bottom-0 z-10 cursor-w-resize transition-colors opacity-0 group-hover:opacity-100"
          style={{
            left: RESIZE_HANDLE_WIDTH / 2,
            width: TRIM_HANDLE_WIDTH,
            background:
              trimSideActive === 'head'
                ? 'rgba(251, 191, 36, 0.85)'
                : 'rgba(251, 191, 36, 0.35)',
          }}
          onPointerDown={(e) => onTrimPointerDown(e, 'head')}
          onPointerMove={onTrimPointerMove}
          onPointerUp={onTrimPointerUp}
          onPointerCancel={onTrimPointerUp}
          aria-label={`Drag to trim the head of shot ${index + 1}`}
        />
      )}

      {/* Tail trim handle. Inside the right edge, set in by the resize
          handle's width so the two don't overlap. */}
      {onTrimPointerDown && (
        <div
          className="absolute top-0 bottom-0 z-10 cursor-e-resize transition-colors opacity-0 group-hover:opacity-100"
          style={{
            right: RESIZE_HANDLE_WIDTH,
            width: TRIM_HANDLE_WIDTH,
            background:
              trimSideActive === 'tail'
                ? 'rgba(251, 191, 36, 0.85)'
                : 'rgba(251, 191, 36, 0.35)',
          }}
          onPointerDown={(e) => onTrimPointerDown(e, 'tail')}
          onPointerMove={onTrimPointerMove}
          onPointerUp={onTrimPointerUp}
          onPointerCancel={onTrimPointerUp}
          aria-label={`Drag to trim the tail of shot ${index + 1}`}
        />
      )}

      {/* Trim tooltip — surfaces the live ms value above the card
          while a trim drag is active on this card. */}
      {trimSideActive !== null && (
        <div
          className="absolute -top-6 text-[10px] px-1.5 py-0.5 rounded tabular-nums z-20"
          style={{
            background: 'rgba(0,0,0,0.85)',
            color: 'rgb(252, 211, 77)',
            left: trimSideActive === 'head' ? 0 : 'auto',
            right: trimSideActive === 'tail' ? 0 : 'auto',
          }}
        >
          {trimSideActive === 'head' ? '⏵' : '⏴'}{' '}
          {formatMs((trimSideActive === 'head' ? (trimStartMs ?? 0) : (trimEndMs ?? 0)))}
        </div>
      )}

      {/* Leading-edge resize handle. Mirrors the trailing-edge handle
          below but on the LEFT side. Skipped on the first card (no
          left neighbor to carve from). Drives the SET_SHOT_TIMING
          reducer via `onLeadingResize` — the new dual-edge timing
          command introduced in
          `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`. */}
      {onLeadingResizePointerDown && (
        <div
          className="absolute top-0 bottom-0 z-10 cursor-ew-resize transition-colors"
          style={{
            left: -RESIZE_HANDLE_WIDTH / 2,
            width: RESIZE_HANDLE_WIDTH,
            background: isLeadingResizing
              ? 'rgba(167, 139, 250, 0.8)'
              : 'transparent',
          }}
          onPointerDown={onLeadingResizePointerDown}
          onPointerMove={onLeadingResizePointerMove}
          onPointerUp={onLeadingResizePointerUp}
          onPointerCancel={onLeadingResizePointerUp}
          aria-hidden
        />
      )}

      {/* Trailing-edge resize handle. Reaches a few pixels beyond
          the card boundary so the adjacent card's leading edge is
          grabbable too — except on the last card, flush there. */}
      {onResizePointerDown && (
        <div
          className="absolute top-0 bottom-0 z-10 cursor-ew-resize transition-colors"
          style={{
            right: -RESIZE_HANDLE_WIDTH / 2,
            width: RESIZE_HANDLE_WIDTH,
            background: isResizing
              ? 'rgba(167, 139, 250, 0.8)'
              : 'transparent',
          }}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          aria-hidden
        />
      )}

      {/* Leading-drag tooltip — live preview startMs while dragging
          the LEFT edge. Anchored at the LEFT edge so the user sees
          the new start time near where they're pointing. */}
      {isLeadingResizing && leadingResizePreviewStartMs !== null && (
        <div
          className="absolute -top-6 left-0 text-[10px] px-1.5 py-0.5 rounded tabular-nums z-20"
          style={{
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
          }}
        >
          {formatTimecode(leadingResizePreviewStartMs)}
        </div>
      )}

      {/* Drag tooltip — live preview ms above the card while resizing. */}
      {isResizing && resizePreviewMs !== null && (
        <div
          className="absolute -top-6 right-0 text-[10px] px-1.5 py-0.5 rounded tabular-nums z-20"
          style={{
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            transform: 'translateX(50%)',
          }}
        >
          {formatMs(resizePreviewMs)}
        </div>
      )}

      {/* Split-at-playhead affordance. A scissors button anchored at
          the playhead's X within this card. Only renders on the
          SELECTED card AND when the playhead position would produce
          two legal halves (parent computes `splitOffsetPx`). Click
          dispatches SPLIT_SHOT. Mirrors the same action as the B / S
          keyboard shortcut and the right-click "Split at playhead"
          context menu item. See `_plans/2026-06-02-shot-split-ui.md`.
       */}
      {isSelected && splitOffsetPx !== null && onSplit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            console.info('[editor split] click', { source: 'timeline-card-button' });
            onSplit();
          }}
          className="absolute z-30 rounded-full w-5 h-5 flex items-center justify-center text-[11px] leading-none transition-transform hover:scale-110"
          style={{
            left: splitOffsetPx,
            top: GRAB_HANDLE_HEIGHT + 4,
            transform: 'translateX(-50%)',
            background: 'rgba(239, 68, 68, 0.95)',
            color: '#fff',
            border: '1px solid rgba(0, 0, 0, 0.6)',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.6)',
            cursor: 'pointer',
          }}
          title="Split shot at playhead (B / S)"
          aria-label="Split shot at playhead"
        >
          ✂
        </button>
      )}
    </div>
  );
}

