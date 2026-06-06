'use client';

/**
 * CapCutVideoLane — CapCut-style video timeline inside TimelineV2.
 *
 * Replaces the legacy `<Timeline>` (src/components/editor/Timeline.tsx)
 * inside the multi-lane shell at TimelineV2.tsx. Same prop surface —
 * same callbacks, same shotIndex semantics — so the parent
 * (EditorClient) keeps dispatching the existing `EditorCommand`s
 * (RESIZE_SHOT, SET_SHOT_TIMING, REORDER_SHOTS, SPLIT_SHOT, etc.).
 *
 * Built on `@xzdarcy/react-timeline-editor`, the same library the
 * standalone `/timeline-editor/[id]` page uses, so the two surfaces
 * feel identical.
 *
 * Plan: `_plans/2026-06-06-capcut-video-lane-in-timelinev2.md`.
 *
 * What this component owns:
 *   - Converting `videoConfig.shots[]` → library `editorData` (one
 *     "video" row whose `actions[]` is the shot list).
 *   - Library event → host callback mapping. Right-edge resize fires
 *     `onResize`; left-edge resize fires `onLeadingResize`; click
 *     fires `onSelect`; move-end fires `onReorder` after the drop
 *     position is mapped to a target index. Right-click fires
 *     `onShotContextMenu` with viewport coords.
 *   - Visual rendering of each clip — image thumbnail + duration
 *     label + selection ring + transition glyph (Phase 3 will fill
 *     in the cross-fade toggle button).
 *
 * What this component does NOT own:
 *   - Editor state. It's a controlled component: `config`, `selection`,
 *     `playheadMs`, `rowTrims`, `rowTransitions` come in as props;
 *     mutations leave as callbacks. The command pipeline in
 *     `src/lib/editor/store.ts` is the source of truth.
 *   - Undo/redo. Each user gesture dispatches a single command at
 *     drag-end (or per-tick during a live resize, which the store
 *     dedupes by value).
 *   - The playhead rendering. TimelineV2 renders a tall vertical line
 *     spanning every lane; we tell the library `hideCursor` so its own
 *     cursor doesn't fight ours.
 */

import { Timeline as LibTimeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { VideoConfig, VideoShot } from '@/remotion/types';
import { ShotKindBadge } from '@/components/editor/ShotKindBadge';

/** Library's per-action shape we feed in. Re-stated locally so this
 *  file doesn't depend on `@xzdarcy/timeline-engine`'s internal types. */
interface LibTimelineEffect {
  id: string;
  name: string;
}

interface LibAction {
  id: string;
  start: number; // seconds
  end: number;   // seconds
  effectId: 'video';
  /** Side-channel data the action renderer reads. The library passes
   *  this through verbatim. */
  data: {
    shotIndex: number;
    shot: VideoShot;
    imageUrl: string;
    transition: 'cross-fade' | null;
    trimStartMs: number;
    trimEndMs: number;
    hasBroll: boolean;
  };
}

interface LibRow {
  id: string;
  actions: LibAction[];
}

const TIMELINE_EFFECTS: Record<string, LibTimelineEffect> = {
  video: { id: 'video', name: 'Video' },
};

/** Default px/second when the parent doesn't pass an explicit zoom.
 *  Matches the legacy `<Timeline>`'s default (80 px/s). */
const DEFAULT_PX_PER_SECOND = 80;
/** Library `scale` = seconds per major tick. We keep the library's
 *  major tick at 1 second so `scaleWidth` directly equals
 *  `pixelsPerSecond`. */
const TICK_SECONDS = 1;
/** Number of subdivisions within each major tick. 10 is what the
 *  standalone timeline editor uses; matches CapCut's feel. */
const SCALE_SPLIT_COUNT = 10;
/** Library default row height (32px) is way too short for thumbnails
 *  that need to communicate shot identity at a glance — image, kind
 *  badge, transition glyph, trim handles, duration label. 104 leaves
 *  generous vertical room for the thumbnail to dominate (the user's
 *  primary signal) while corner badges sit on top without eating the
 *  visible image. Update `VIDEO_LANE_HEIGHT_DEFAULT` in TimelineV2 in
 *  lockstep. */
const ROW_HEIGHT_PX = 104;
/** Pixel offset where the first tick starts. TimelineV2's shared
 *  playhead (rendered at the parent level) computes its X as
 *  `(playheadMs / 1000) * pixelsPerSecond` assuming `t=0` sits at
 *  the leftmost edge of the tracks column — so the video lane has
 *  to match. Setting this to 0 keeps the playhead, the audio
 *  waveform, the captions pills, and the video clips on the same
 *  millisecond. */
const START_LEFT_PX = 0;

export interface CapCutVideoLaneProps {
  config: VideoConfig;
  rowImages: Record<number, string>;
  selection: number | null;
  /** Current playhead position in ms. Used only for the scissors
   *  affordance (Phase 2) — the visible playhead line lives on
   *  TimelineV2, not here. */
  playheadMs: number;
  /** Per-shot B-roll trim values. Phase 3. */
  rowTrims?: Record<number, { trimStartMs?: number; trimEndMs?: number }>;
  /** Per-shot cross-fade transition flags. */
  rowTransitions?: Record<number, 'cross-fade' | null | undefined>;
  /** Px / second. Matches the legacy Timeline prop. */
  pixelsPerSecond?: number;
  onSelect: (shotIndex: number) => void;
  /** Fired live on every right-edge resize tick AND on drop. The
   *  store dedupes identical values so the per-tick stream is safe. */
  onResize?: (shotIndex: number, newDurationMs: number) => void;
  /** Fired live on every left-edge resize tick AND on drop. Dispatches
   *  `SET_SHOT_TIMING { startMs: new, endMs: unchanged }` so the
   *  previous shot extends in one atomic step. */
  onLeadingResize?: (shotIndex: number, newStartMs: number) => void;
  /** Fires only on drag-end (drop). Per the 2026-06-06 plan
   *  open-question 1: drop-only matches the legacy editor's
   *  behavior + avoids undo-stack pollution. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Phase 3. Fires on B-roll head/tail trim handle release. */
  onTrim?: (
    shotIndex: number,
    values: { trimStartMs?: number | null; trimEndMs?: number | null },
  ) => void;
  /** Phase 3. Cross-fade transition toggle. */
  onToggleTransition?: (shotIndex: number, transition: 'cross-fade' | null) => void;
  /** Right-click → parent opens its centralized context menu. */
  onShotContextMenu?: (shotIndex: number, x: number, y: number) => void;
  /** Phase 2. Insert-scene "+" seam buttons. */
  onInsertScene?: (
    atIndex: number,
    mode: 'carve' | 'shift',
    carveFrom?: 'left' | 'right' | 'auto',
  ) => void;
  /** Default duration (ms) for an inserted blank scene. Surfaces in
   *  the "+" affordance's button labels. */
  insertSceneDefaultDurationMs?: number;
  /** Phase 2. When a split at the current playhead would produce two
   *  legal halves, this is the affected shot's index. Renders a
   *  scissors button at the playhead X on that card. */
  splitAvailableShotIndex?: number | null;
  /** Phase 2. Click on the scissors button. */
  onSplit?: () => void;
}

/** Build the library's `editorData` from the legacy editor's
 *  `VideoConfig`. One row, one action per shot. Pure — every input
 *  is a primitive or a stable ref. */
function buildEditorData(
  shots: readonly VideoShot[],
  rowImages: Record<number, string>,
  rowTransitions: Record<number, 'cross-fade' | null | undefined> | undefined,
  rowTrims: Record<number, { trimStartMs?: number; trimEndMs?: number }> | undefined,
): LibRow[] {
  const actions: LibAction[] = shots.map((shot, i) => {
    const startSec = shot.startMs / 1000;
    const endSec = (shot.startMs + shot.durationMs) / 1000;
    const transition = rowTransitions?.[i] === 'cross-fade' ? 'cross-fade' : null;
    const trim = rowTrims?.[i];
    return {
      id: `shot-${i}`,
      start: startSec,
      end: endSec,
      effectId: 'video',
      data: {
        shotIndex: i,
        shot,
        imageUrl: rowImages[i] ?? '',
        transition,
        trimStartMs: typeof trim?.trimStartMs === 'number' ? trim.trimStartMs : 0,
        trimEndMs: typeof trim?.trimEndMs === 'number' ? trim.trimEndMs : 0,
        // Head/tail trim handles only render for B-roll shots — the
        // concept is "shave seconds off the source video". Stills and
        // motion-collage shots don't have a source to trim.
        hasBroll: Boolean(shot.videoUrl) || shot.sceneType === 'b-roll',
      },
    };
  });
  return [{ id: 'video', actions }];
}

/** Map a drop position (ms, absolute) to the target row index after
 *  drag-reorder. Walks `shots[]` skipping the dragged shot, then picks
 *  the seam closest to `dropMs`. Tie-breaks left so the user's intent
 *  is "before X" rather than "after X" when they're between seams.
 *
 *  Exported for the targeted adapter test in
 *  `tests/capcut-video-lane-adapter.test.ts`. */
export function targetIndexFromShotsDropMs(
  shots: readonly VideoShot[],
  fromIndex: number,
  dropMs: number,
): number {
  if (fromIndex < 0 || fromIndex >= shots.length) return fromIndex;
  const seamMs: number[] = [0];
  let cursor = 0;
  for (let i = 0; i < shots.length; i++) {
    if (i === fromIndex) continue;
    cursor += shots[i].durationMs;
    seamMs.push(cursor);
  }
  let bestSeam = 0;
  let bestDist = Math.abs(dropMs - seamMs[0]);
  for (let i = 1; i < seamMs.length; i++) {
    const d = Math.abs(dropMs - seamMs[i]);
    if (d < bestDist) {
      bestSeam = i;
      bestDist = d;
    }
  }
  return bestSeam;
}

export function CapCutVideoLane({
  config,
  rowImages,
  selection,
  playheadMs,
  rowTrims,
  rowTransitions,
  pixelsPerSecond = DEFAULT_PX_PER_SECOND,
  onSelect,
  onResize,
  onLeadingResize,
  onReorder,
  onTrim,
  onToggleTransition,
  onShotContextMenu,
  onInsertScene,
  insertSceneDefaultDurationMs,
  splitAvailableShotIndex,
  onSplit,
}: CapCutVideoLaneProps): React.ReactElement {
  // `onInsertScene` / `insertSceneDefaultDurationMs` are wired in a
  // follow-up — silence the unused-prop lint for now so callers don't
  // have to omit them yet. See the "+" seam affordance todo.
  void onInsertScene;
  void insertSceneDefaultDurationMs;

  const timelineRef = useRef<TimelineState>(null);

  const editorData = useMemo(
    () => buildEditorData(config.shots, rowImages, rowTransitions, rowTrims),
    [config.shots, rowImages, rowTransitions, rowTrims],
  );

  // Hold a ref to the shots array so the library's event closures (which
  // the library captures once per render) can read the freshest value
  // when the user drags multiple times in a row without re-mounting.
  const shotsRef = useRef(config.shots);
  shotsRef.current = config.shots;

  // ── Resize handlers ────────────────────────────────────────────────
  //
  // The library's `dir` distinguishes left-edge from right-edge drag.
  // Both cases collapse to a different command:
  //   - dir='right' → RESIZE_SHOT (changes duration, keeps start fixed)
  //   - dir='left'  → SET_SHOT_TIMING (changes start, keeps end fixed)
  //
  // We fire on every tick (matching the legacy <Timeline>); the store
  // detects no-ops by value and short-circuits. ResizeEnd re-fires the
  // final value as a defensive against the library reporting unrounded
  // numbers at the very end of the gesture.
  const handleResizing = useCallback(
    (args: { action: { id: string; data?: LibAction['data'] }; start: number; end: number; dir: 'left' | 'right' }) => {
      const data = args.action.data;
      if (!data) return;
      if (args.dir === 'right') {
        if (!onResize) return;
        const newDurationMs = Math.max(0, (args.end - args.start) * 1000);
        if (typeof console !== 'undefined' && console.info) {
          console.info('[capcut-video-lane resizing]', {
            shotIndex: data.shotIndex,
            edge: 'right',
            newDurationMs,
          });
        }
        onResize(data.shotIndex, newDurationMs);
      } else {
        if (!onLeadingResize) return;
        const newStartMs = Math.max(0, args.start * 1000);
        if (typeof console !== 'undefined' && console.info) {
          console.info('[capcut-video-lane resizing]', {
            shotIndex: data.shotIndex,
            edge: 'left',
            newStartMs,
          });
        }
        onLeadingResize(data.shotIndex, newStartMs);
      }
      // Returning undefined lets the library apply the visual change.
      return undefined;
    },
    [onResize, onLeadingResize],
  );

  const handleResizeEnd = useCallback(
    (args: { action: { id: string; data?: LibAction['data'] }; start: number; end: number; dir: 'left' | 'right' }) => {
      const data = args.action.data;
      if (!data) return;
      // Re-fire the final snapped value. handleResizing already fired
      // on every tick; this is the defensive "commit" the legacy
      // <Timeline> also issued at pointer-up.
      if (args.dir === 'right' && onResize) {
        onResize(data.shotIndex, Math.max(0, (args.end - args.start) * 1000));
      } else if (args.dir === 'left' && onLeadingResize) {
        onLeadingResize(data.shotIndex, Math.max(0, args.start * 1000));
      }
      if (typeof console !== 'undefined' && console.info) {
        console.info('[capcut-video-lane resize end]', {
          shotIndex: data.shotIndex,
          edge: args.dir,
        });
      }
    },
    [onResize, onLeadingResize],
  );

  // ── Reorder (drop-only) ────────────────────────────────────────────
  //
  // The library lets us return false from onActionMoving to block live
  // movement, but per the 2026-06-06 plan open-question 1 we let the
  // user drag freely; we snap to the nearest seam on drop. This avoids
  // dispatching REORDER_SHOTS per move tick (which would flood the
  // undo stack with intermediate states).
  const handleMoveEnd = useCallback(
    (args: { action: { id: string; data?: LibAction['data'] }; start: number }) => {
      const data = args.action.data;
      if (!data) return;
      if (!onReorder) return;
      const dropMs = Math.max(0, args.start * 1000);
      const toIndex = targetIndexFromShotsDropMs(shotsRef.current, data.shotIndex, dropMs);
      if (typeof console !== 'undefined' && console.info) {
        console.info('[capcut-video-lane reorder]', {
          fromIndex: data.shotIndex,
          toIndex,
          dropMs,
        });
      }
      if (toIndex !== data.shotIndex) onReorder(data.shotIndex, toIndex);
    },
    [onReorder],
  );

  // ── Click → select ─────────────────────────────────────────────────
  //
  // The library passes the underlying React MouseEvent. We don't need
  // the coordinates — selection is by shotIndex — but we DO consume
  // the event so the lane's background-click logic (TimelineV2 owns
  // lane focus) doesn't fire afterwards.
  const handleClickAction = useCallback(
    (
      e: React.MouseEvent<HTMLElement, MouseEvent>,
      param: { action: { id: string; data?: LibAction['data'] } },
    ) => {
      e.stopPropagation();
      const data = param.action.data;
      if (!data) return;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[capcut-video-lane select]', { shotIndex: data.shotIndex });
      }
      onSelect(data.shotIndex);
    },
    [onSelect],
  );

  // ── Right-click → host context menu ────────────────────────────────
  const handleContextMenuAction = useCallback(
    (
      e: React.MouseEvent<HTMLElement, MouseEvent>,
      param: { action: { id: string; data?: LibAction['data'] } },
    ) => {
      const data = param.action.data;
      if (!data) return;
      if (!onShotContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof console !== 'undefined' && console.info) {
        console.info('[capcut-video-lane context menu]', {
          shotIndex: data.shotIndex,
          x: e.clientX,
          y: e.clientY,
        });
      }
      onShotContextMenu(data.shotIndex, e.clientX, e.clientY);
    },
    [onShotContextMenu],
  );

  // ── B-roll head/tail trim handle drag ──────────────────────────────
  //
  // Trim is independent from resize: it shaves source seconds off the
  // front/back of the B-roll video URL without changing the SCENE's
  // duration. Renders as a thin inset handle inside the clip; we own
  // the mousedown/mousemove/up cycle ourselves because the library
  // doesn't expose a trim concept.
  const trimDragRef = useRef<
    | { shotIndex: number; side: 'head' | 'tail'; startClientX: number; startTrimMs: number }
    | null
  >(null);
  useEffect(() => {
    if (!onTrim) return;
    // Pin the narrowed value into a const so the inner closures see
    // `onTrim` as defined without re-narrowing at every call site.
    const fireTrim = onTrim;
    function onMove(e: MouseEvent) {
      const drag = trimDragRef.current;
      if (!drag) return;
      const deltaPx = e.clientX - drag.startClientX;
      const deltaMs = (deltaPx / pixelsPerSecond) * 1000;
      // Head trim grows as you drag right (positive delta = more shave);
      // tail trim grows as you drag LEFT (negative delta = more shave).
      const direction = drag.side === 'head' ? 1 : -1;
      const nextTrimMs = Math.max(0, drag.startTrimMs + direction * deltaMs);
      if (drag.side === 'head') {
        fireTrim(drag.shotIndex, { trimStartMs: nextTrimMs });
      } else {
        fireTrim(drag.shotIndex, { trimEndMs: nextTrimMs });
      }
    }
    function onUp() {
      const drag = trimDragRef.current;
      if (drag && typeof console !== 'undefined' && console.info) {
        console.info('[capcut-video-lane trim end]', {
          shotIndex: drag.shotIndex,
          side: drag.side,
        });
      }
      trimDragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    function attach() {
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    }
    function onDown(e: Event) {
      const target = e.target as HTMLElement | null;
      const handle = target?.closest<HTMLElement>('[data-capcut-trim-handle]');
      if (!handle) return;
      const shotIndex = Number(handle.dataset.shotIndex);
      const side = handle.dataset.side as 'head' | 'tail';
      const startTrimMs = Number(handle.dataset.startTrimMs) || 0;
      if (!Number.isFinite(shotIndex) || (side !== 'head' && side !== 'tail')) return;
      e.preventDefault();
      e.stopPropagation();
      trimDragRef.current = {
        shotIndex,
        side,
        startClientX: (e as MouseEvent).clientX,
        startTrimMs,
      };
      attach();
    }
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onTrim, pixelsPerSecond]);

  // ── Action renderer (per-clip card) ────────────────────────────────
  //
  // Everything visual lives here: thumbnail, selection ring, transition
  // glyph + toggle, scissors-at-playhead button, B-roll head/tail trim
  // handles. Renders INSIDE the library's action rectangle so it rides
  // the library's scroll/zoom for free — no DOM overlay sync needed.
  const getActionRender = useCallback(
    (action: { id: string; data?: LibAction['data'] }) => {
      const data = action.data;
      if (!data) {
        return (
          <div className="flex h-full items-center justify-center bg-red-950/40 px-1 font-mono text-[9px] text-red-300">
            ? {action.id}
          </div>
        );
      }
      const isSelected = selection === data.shotIndex;
      // Selection state — built from raw box-shadow so the library's
      // own action CSS can't override Tailwind ring utilities. Three
      // layered shadows: inset border (the colored ring), outer
      // halo (the glow), drop-shadow (depth). Inactive cards get a
      // single subtle inset border for separation against the lane
      // background.
      const selectionShadow = isSelected
        ? [
            'inset 0 0 0 3px rgba(56, 189, 248, 1)', // sky-400, solid 3px ring
            '0 0 0 1px rgba(125, 211, 252, 0.55)',   // light outer outline
            '0 0 18px 2px rgba(56, 189, 248, 0.55)', // outer glow
            '0 2px 4px rgba(0, 0, 0, 0.45)',         // depth shadow
          ].join(', ')
        : [
            'inset 0 0 0 1px rgba(115, 115, 115, 0.55)',
            '0 1px 2px rgba(0, 0, 0, 0.35)',
          ].join(', ');
      const labelMs = (data.shot.durationMs / 1000).toFixed(1) + 's';
      // Scissors button — only on the selected card AND only when the
      // playhead sits inside this shot AND a split here would produce
      // two legal halves (parent enforces the legality check by setting
      // `splitAvailableShotIndex`).
      const showScissors =
        isSelected &&
        splitAvailableShotIndex === data.shotIndex &&
        onSplit &&
        playheadMs >= data.shot.startMs &&
        playheadMs < data.shot.startMs + data.shot.durationMs;
      const scissorsOffsetPx = showScissors
        ? ((playheadMs - data.shot.startMs) / 1000) * pixelsPerSecond
        : null;
      // Trim handle widths in px. Inset 4px from the card edge so they
      // don't compete with the library's resize hot-zone (which lives
      // ON the edge).
      const TRIM_HANDLE_WIDTH_PX = 5;
      const TRIM_HANDLE_INSET_PX = 4;
      return (
        <div
          className="relative flex h-full w-full overflow-hidden rounded-md"
          style={{
            // Slightly tinted-blue when selected so even with the
            // image filling the card the surrounding rim reads blue.
            background: isSelected ? '#0c1a2a' : data.imageUrl ? '#0a0a0f' : '#1f1f29',
            boxShadow: selectionShadow,
            // Pointer affordance — the library doesn't set one and
            // the default arrow cursor makes the card feel un-
            // interactive. Inside the card the trim handles
            // override this with ew-resize.
            cursor: 'pointer',
          }}
          // Belt-and-suspenders for right-click. The library also fires
          // `onContextMenuAction` (wired below), but its callback runs
          // AFTER the React event has already bubbled, which sometimes
          // lets the browser's native menu flash before the host menu
          // takes over. Catching contextmenu here, on the card wrapper,
          // suppresses the native menu first and dispatches the host's
          // menu in one synchronous step.
          onContextMenu={(e) => {
            if (!onShotContextMenu) return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof console !== 'undefined' && console.info) {
              console.info('[capcut-video-lane context menu]', {
                shotIndex: data.shotIndex,
                x: e.clientX,
                y: e.clientY,
                via: 'card-wrapper',
              });
            }
            onShotContextMenu(data.shotIndex, e.clientX, e.clientY);
          }}
        >
          {data.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.imageUrl}
              alt=""
              draggable={false}
              style={{
                width: '100%',
                height: '100%',
                // `contain` shows the WHOLE frame inside the card
                // even when the clip is narrow at low zoom. Before
                // this we used `cover`, which cropped the image to
                // a vertical sliver on short clips — the user
                // couldn't tell what the shot was supposed to be.
                // Letterbox bars on the sides take the card's
                // background colour for a clean look.
                objectFit: 'contain',
                // Brighter when selected so the user's pick reads as
                // "live" instead of "dimmed like the rest". Lifted
                // slightly across the board so the timeline doesn't
                // look washed out at the new ROW_HEIGHT.
                opacity: isSelected ? 1 : 0.92,
                pointerEvents: 'none',
              }}
            />
          ) : null}
          {/* ShotKindBadge — TITLE / COLLAGE / MOTION / STAT / B-ROLL /
              BLANK / ANIM. Sits top-left so it's always visible even
              when the card is narrow at low zoom. Reuses the same
              resolver `rowKind` that the SHOTS-rail filter and legacy
              shot-graph editor both consume, so the badge can't drift
              from the inspector's "Shot type" dropdown. */}
          <div
            style={{
              position: 'absolute',
              top: 3,
              left: 3,
              zIndex: 2,
              pointerEvents: 'none',
            }}
          >
            <ShotKindBadge
              shotKind={data.shot.shotKind}
              visualType={data.shot.visualType}
              pinTopLeft={false}
              scale="sm"
            />
          </div>
          {/* Top-right cluster: shot index + cross-fade toggle. Small
              pill backgrounds so they sit ON the image without darkening
              the rest of the card — old full-width gradient strips ate
              ~16px of visible thumbnail at the top and bottom. */}
          <div
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <span
              className="pointer-events-none"
              style={{
                padding: '1px 5px',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1.1,
                color: '#fff',
                background: 'rgba(0, 0, 0, 0.6)',
                borderRadius: 3,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
              }}
            >
              #{data.shotIndex + 1}
            </span>
            {onToggleTransition ? (
              <button
                type="button"
                style={{
                  pointerEvents: 'auto',
                  padding: '1px 5px',
                  fontSize: 11,
                  fontWeight: 700,
                  lineHeight: 1,
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: data.transition === 'cross-fade' ? '#7dd3fc' : '#a3a3a3',
                  border: 'none',
                  borderRadius: 3,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                  cursor: 'pointer',
                }}
                title={data.transition === 'cross-fade' ? 'Cross-fade in (click to clear)' : 'Add cross-fade in'}
                aria-label={data.transition === 'cross-fade' ? 'Clear cross-fade' : 'Add cross-fade'}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = data.transition === 'cross-fade' ? null : 'cross-fade';
                  if (typeof console !== 'undefined' && console.info) {
                    console.info('[capcut-video-lane transition toggle]', {
                      shotIndex: data.shotIndex,
                      next,
                    });
                  }
                  onToggleTransition(data.shotIndex, next);
                }}
              >
                ⤬
              </button>
            ) : data.transition === 'cross-fade' ? (
              <span
                className="pointer-events-none"
                style={{
                  padding: '1px 5px',
                  fontSize: 11,
                  fontWeight: 700,
                  lineHeight: 1,
                  color: '#7dd3fc',
                  background: 'rgba(0, 0, 0, 0.6)',
                  borderRadius: 3,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                }}
                title="Cross-fade in"
              >
                ⤬
              </span>
            ) : null}
          </div>
          {/* Bottom-right: duration pill. Replaces the old full-width
              gradient bottom strip so the thumbnail stretches all the
              way to the card edge. */}
          <span
            className="pointer-events-none"
            style={{
              position: 'absolute',
              bottom: 3,
              right: 3,
              zIndex: 2,
              padding: '1px 5px',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: 1.1,
              fontVariantNumeric: 'tabular-nums',
              color: '#fff',
              background: 'rgba(0, 0, 0, 0.6)',
              borderRadius: 3,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            }}
          >
            {labelMs}
          </span>
          {/* B-roll head trim handle. Mouse-down sets trim_start_ms via
              the document-level drag handlers wired in the useEffect
              above. Inset from the card's left edge so the library's
              leading-resize hot-zone still gets pointer events. */}
          {data.hasBroll && onTrim ? (
            <div
              data-capcut-trim-handle
              data-shot-index={data.shotIndex}
              data-side="head"
              data-start-trim-ms={data.trimStartMs}
              title="Trim source from the head (drag right to shave)"
              style={{
                position: 'absolute',
                top: 22,
                bottom: 22,
                left: TRIM_HANDLE_INSET_PX,
                width: TRIM_HANDLE_WIDTH_PX,
                background: 'rgba(250, 204, 21, 0.7)',
                cursor: 'ew-resize',
                borderRadius: 2,
              }}
            />
          ) : null}
          {/* B-roll tail trim handle. */}
          {data.hasBroll && onTrim ? (
            <div
              data-capcut-trim-handle
              data-shot-index={data.shotIndex}
              data-side="tail"
              data-start-trim-ms={data.trimEndMs}
              title="Trim source from the tail (drag left to shave)"
              style={{
                position: 'absolute',
                top: 22,
                bottom: 22,
                right: TRIM_HANDLE_INSET_PX,
                width: TRIM_HANDLE_WIDTH_PX,
                background: 'rgba(250, 204, 21, 0.7)',
                cursor: 'ew-resize',
                borderRadius: 2,
              }}
            />
          ) : null}
          {/* Scissors button at the playhead's X within this card. */}
          {showScissors && scissorsOffsetPx !== null ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (typeof console !== 'undefined' && console.info) {
                  console.info('[capcut-video-lane split]', {
                    shotIndex: data.shotIndex,
                    playheadMs,
                  });
                }
                onSplit?.();
              }}
              title="Split shot at playhead (S)"
              aria-label="Split shot at playhead"
              style={{
                position: 'absolute',
                left: scissorsOffsetPx,
                top: 18,
                width: 20,
                height: 20,
                borderRadius: 999,
                background: 'rgba(239, 68, 68, 0.95)',
                color: '#fff',
                border: '1px solid rgba(0, 0, 0, 0.6)',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.6)',
                fontSize: 11,
                lineHeight: '1',
                cursor: 'pointer',
                transform: 'translateX(-50%)',
                zIndex: 30,
              }}
            >
              ✂
            </button>
          ) : null}
        </div>
      );
    },
    [
      selection,
      splitAvailableShotIndex,
      onSplit,
      onToggleTransition,
      onTrim,
      playheadMs,
      pixelsPerSecond,
    ],
  );

  // Library refuses to render any clip past `minScaleCount * TICK_SECONDS`.
  // Set this from the actual total so a long doc isn't clipped.
  const totalSec = useMemo(() => {
    const last = config.shots[config.shots.length - 1];
    return last ? (last.startMs + last.durationMs) / 1000 : 0;
  }, [config.shots]);
  const minScaleCount = useMemo(
    () => Math.max(20, Math.ceil(totalSec + 5)),
    [totalSec],
  );

  return (
    <LibTimeline
      ref={timelineRef}
      editorData={editorData}
      effects={TIMELINE_EFFECTS}
      scale={TICK_SECONDS}
      scaleWidth={pixelsPerSecond * TICK_SECONDS}
      scaleSplitCount={SCALE_SPLIT_COUNT}
      rowHeight={ROW_HEIGHT_PX}
      startLeft={START_LEFT_PX}
      minScaleCount={minScaleCount}
      autoScroll
      dragLine
      gridSnap
      // TimelineV2 renders the shared playhead spanning every lane.
      // Hiding the library cursor keeps the two from fighting.
      hideCursor
      style={{ height: ROW_HEIGHT_PX + 32, width: '100%' }}
      getActionRender={getActionRender}
      onActionResizing={handleResizing}
      onActionResizeEnd={handleResizeEnd}
      onActionMoveEnd={handleMoveEnd}
      onClickAction={handleClickAction}
      onContextMenuAction={handleContextMenuAction}
      onChange={() => { /* library bookkeeping; commands flow via callbacks above */ }}
    />
  );
}
