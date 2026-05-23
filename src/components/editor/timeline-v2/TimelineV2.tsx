'use client';

/**
 * TimelineV2 — multi-lane timeline shell, Phase 5 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Replaces the single-row Timeline with four stacked lanes that
 * share one horizontal scroll and one playhead:
 *
 *   ┌─────────── time ruler ─────────────────────────────┐
 *   ▶ video    [thumb 1][thumb 2][thumb 3][thumb 4]
 *   ▶ audio    ░▒▓ wavesurfer waveform ▓▒░
 *   ▶ captions  "Morris Worm"  "10% OF NET"  "60k machines"
 *   ▶ overlays              ❒              ❒
 *
 * The video lane wraps the existing `<Timeline>` component (untouched
 * — all the drag-resize / drag-reorder / trim logic stays put).
 * The audio / captions / overlays lanes are new visual representations
 * driven by the same canonical state.
 *
 * The playhead is rendered once at the TimelineV2 level as a tall
 * vertical line spanning every lane, so the eye reads "this is one
 * project at one moment in time" instead of "four disconnected rows."
 */

import { useMemo, useRef, useEffect } from 'react';
import type { VideoConfig } from '@/remotion/types';
import type { ProductionDoc, RowOverlayRenderState } from '@/remotion/utils';
import type { CaptionsBundle } from '@/lib/editor/captions';
import { Timeline } from '@/components/editor/Timeline';
import { TimelineRuler } from './TimelineRuler';
import { AudioLane } from './AudioLane';
import { CaptionsLane } from './CaptionsLane';
import { OverlaysLane } from './OverlaysLane';
import { ZoomIn, ZoomOut } from 'lucide-react';

/** Per-lane heights — defaults match the plan's 48 px tracks. The
 *  audio lane is slightly taller so the waveform has room to breathe;
 *  captions / overlays are shorter because their content is markers,
 *  not images. Defaults below; per-device overrides flow in via
 *  `videoLaneHeight` / `audioLaneHeight` props (see
 *  `editor.timeline.laneHeights.*` in src/lib/editor/settings.ts). */
const VIDEO_LANE_HEIGHT_DEFAULT = 64;
const AUDIO_LANE_HEIGHT_DEFAULT = 56;
const CAPTIONS_LANE_HEIGHT = 32;
const OVERLAYS_LANE_HEIGHT = 28;

const LANE_HEADER_WIDTH = 80;
/** Visual gap between stacked lanes. The gap shows the parent column
 *  background so each lane reads as its own "track strip" — same idea
 *  CapCut / Premiere use. Applied identically to the labels column and
 *  the tracks column so the rows stay aligned across the divider.
 *  Tracked in `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`
 *  §5A option B. */
const LANE_GAP_PX = 6;

/** Identifier passed back when the user clicks a non-shot lane (audio
 *  body, captions body, overlays body). The parent maps this to the
 *  inspector's auto-tab so the right body opens immediately. */
export type TimelineLaneKind = 'audio' | 'captions' | 'overlays';

interface TimelineV2Props {
  config: VideoConfig;
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  rowStartTimesMs: number[];
  rowOverlays: Record<number, RowOverlayRenderState>;
  captions: CaptionsBundle | undefined;
  voiceoverUrl?: string;
  selection: number | null;
  playheadMs: number;
  totalDurationMs: number;
  pixelsPerSecond: number;
  /** Per-shot trim values for the head/tail handles. */
  rowTrims: Record<number, { trimStartMs?: number; trimEndMs?: number }>;
  /** Per-shot transition (cross-fade or none). */
  rowTransitions: Record<number, 'cross-fade' | null | undefined>;
  // Callbacks ─ identical surface to the existing Timeline so the
  // wrapped video lane stays a pure forward.
  onSelect: (shotIndex: number) => void;
  onSeek: (ms: number) => void;
  onResize: (shotIndex: number, durationMs: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onTrim: (
    shotIndex: number,
    values: { trimStartMs?: number | null; trimEndMs?: number | null },
  ) => void;
  onToggleTransition: (shotIndex: number, transition: 'cross-fade' | null) => void;
  // Captions ─ inline edit dispatches an update via the parent.
  onUpdateCaption: (segmentIndex: number, text: string) => void;
  // Overlays ─ marker click jumps to the shot AND opens the position editor.
  onOpenOverlayPosition: (shotIndex: number) => void;
  // Zoom controls
  zoomLevel: number;
  zoomMin: number;
  zoomMax: number;
  onZoomChange: (level: number) => void;
  // Per-device lane-height overrides from settings. Optional so
  // existing callers don't have to update; falls back to the
  // canonical defaults when omitted.
  videoLaneHeight?: number;
  audioLaneHeight?: number;
  /** Which non-shot lane currently owns the inspector. Drives the
   *  highlight ring on the lane's track strip so the user can see at
   *  a glance which lane the inspector body refers to. `null` when no
   *  lane is focused (a shot is selected, or nothing is). */
  focusedLane?: TimelineLaneKind | null;
  /** Fires when the user clicks a non-shot lane's background. The
   *  parent dispatches the matching inspector tab + clears the shot
   *  selection so the lane's body owns the inspector. `null` means
   *  "the lane area was clicked but not on a child" — used to
   *  deselect when the user clicks an empty spot. */
  onLaneFocus?: (kind: TimelineLaneKind) => void;
  /** Phase 3: right-click handler for shot cards. Forwarded to the
   *  inner Timeline; the parent opens the centralized context menu
   *  at the supplied viewport coords. */
  onShotContextMenu?: (shotIndex: number, x: number, y: number) => void;
  /** Phase 3: right-click handler for the audio lane. */
  onAudioContextMenu?: (x: number, y: number) => void;
  /** Phase 3: right-click handler for a caption pill. Fires with
   *  the segment index AND viewport coords. */
  onCaptionContextMenu?: (segmentIndex: number, x: number, y: number) => void;
  /** Phase 3: right-click handler for an overlay marker. Fires with
   *  the row index + viewport coords. */
  onOverlayContextMenu?: (shotIndex: number, x: number, y: number) => void;
}

export function TimelineV2({
  config,
  doc,
  rowImages,
  rowStartTimesMs,
  rowOverlays,
  captions,
  voiceoverUrl,
  selection,
  playheadMs,
  totalDurationMs,
  pixelsPerSecond,
  rowTrims,
  rowTransitions,
  onSelect,
  onSeek,
  onResize,
  onReorder,
  onTrim,
  onToggleTransition,
  onUpdateCaption,
  onOpenOverlayPosition,
  zoomLevel,
  zoomMin,
  zoomMax,
  onZoomChange,
  videoLaneHeight = VIDEO_LANE_HEIGHT_DEFAULT,
  audioLaneHeight = AUDIO_LANE_HEIGHT_DEFAULT,
  focusedLane = null,
  onLaneFocus,
  onShotContextMenu,
  onAudioContextMenu,
  onCaptionContextMenu,
  onOverlayContextMenu,
}: TimelineV2Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the playhead into view when it moves out of the
  // visible window — same behaviour CapCut has. We only nudge when
  // the playhead crosses the edge; mid-viewport movements don't
  // jolt the user.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const playheadX = (playheadMs / 1000) * pixelsPerSecond;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth;
    if (playheadX < viewLeft + 40 || playheadX > viewRight - 40) {
      el.scrollLeft = Math.max(0, playheadX - el.clientWidth * 0.4);
    }
  }, [playheadMs, pixelsPerSecond]);

  const totalWidthPx = useMemo(
    () => Math.max(200, Math.round((totalDurationMs / 1000) * pixelsPerSecond)),
    [totalDurationMs, pixelsPerSecond],
  );

  const playheadX = useMemo(
    () => (playheadMs / 1000) * pixelsPerSecond,
    [playheadMs, pixelsPerSecond],
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header — title + zoom controls. */}
      <div
        className="flex items-center px-3 h-7 shrink-0"
        style={{ borderBottom: '1px solid var(--editor-edge)' }}
      >
        <div className="text-[10px] uppercase tracking-wider flex-1" style={{ color: 'var(--fg-muted)' }}>
          Timeline
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="editor-icon-btn"
            onClick={() => onZoomChange(Math.max(zoomMin, zoomLevel - 1))}
            disabled={zoomLevel <= zoomMin}
            aria-label="Zoom out"
            title="Zoom out (−)"
            style={{ width: 22, height: 22 }}
          >
            <ZoomOut size={12} strokeWidth={2} />
          </button>
          <input
            type="range"
            min={zoomMin}
            max={zoomMax}
            step={1}
            value={zoomLevel}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            className="w-24"
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            className="editor-icon-btn"
            onClick={() => onZoomChange(Math.min(zoomMax, zoomLevel + 1))}
            disabled={zoomLevel >= zoomMax}
            aria-label="Zoom in"
            title="Zoom in (+)"
            style={{ width: 22, height: 22 }}
          >
            <ZoomIn size={12} strokeWidth={2} />
          </button>
          <span className="text-[10px] tabular-nums ed-mono w-8 text-right" style={{ color: 'var(--fg-muted)' }}>
            {zoomLevel}×
          </span>
        </div>
      </div>

      {/* Lane stack — left-side lane labels, right-side scrolling
          tracks. Both columns are inside the flex so the labels stay
          visible while the tracks scroll horizontally.
          Each lane is now rendered inside its own "track strip"
          container with a gap between strips (LANE_GAP_PX) so the
          rows read as visually distinct rather than fused. The label
          column applies the same gap to stay aligned. See plan §5A-B. */}
      <div className="flex flex-1" style={{ minHeight: 0 }}>
        {/* Lane labels column ─ fixed, doesn't scroll. */}
        <div
          className="flex flex-col shrink-0"
          style={{ width: LANE_HEADER_WIDTH, borderRight: '1px solid var(--editor-edge)' }}
        >
          <LaneLabel height={22} label="" />
          <LaneLabel height={videoLaneHeight} label="Video" tint="purple" gapBelow />
          <LaneLabel
            height={audioLaneHeight}
            label="Audio"
            tint="cyan"
            gapBelow
            focused={focusedLane === 'audio'}
            onClick={onLaneFocus ? () => onLaneFocus('audio') : undefined}
          />
          <LaneLabel
            height={CAPTIONS_LANE_HEIGHT}
            label="Captions"
            tint="amber"
            gapBelow
            focused={focusedLane === 'captions'}
            onClick={onLaneFocus ? () => onLaneFocus('captions') : undefined}
          />
          <LaneLabel
            height={OVERLAYS_LANE_HEIGHT}
            label="Overlays"
            tint="green"
            focused={focusedLane === 'overlays'}
            onClick={onLaneFocus ? () => onLaneFocus('overlays') : undefined}
          />
        </div>

        {/* Tracks column ─ scrolls horizontally. The playhead overlays
            this column. */}
        <div className="flex-1 relative overflow-hidden">
          <div
            ref={scrollRef}
            className="editor-scroll editor-scroll--timeline"
            style={{
              width: '100%',
              height: '100%',
              overflowX: 'auto',
              overflowY: 'hidden',
            }}
          >
            <div className="flex flex-col" style={{ width: totalWidthPx, minWidth: '100%' }}>
              <TimelineRuler
                totalDurationMs={totalDurationMs}
                pixelsPerSecond={pixelsPerSecond}
                onSeek={onSeek}
              />
              {/* Video lane — reuses the existing Timeline, which
                  brings its drag-resize / drag-reorder / trim
                  behaviour for free. The wrapper here sizes the row
                  AND owns the rounded "track strip" look (overflow
                  hidden so the inner Timeline can't bleed past).
                  Timeline owns the internal layout. */}
              <LaneStrip height={videoLaneHeight} gapBelow>
                <Timeline
                  config={config}
                  rowImages={rowImages}
                  selection={selection}
                  playheadMs={playheadMs}
                  rowTrims={rowTrims}
                  rowTransitions={rowTransitions}
                  pixelsPerSecond={pixelsPerSecond}
                  onSelect={onSelect}
                  onResize={onResize}
                  onReorder={onReorder}
                  onTrim={onTrim}
                  onToggleTransition={onToggleTransition}
                  onShotContextMenu={onShotContextMenu}
                />
              </LaneStrip>
              <LaneStrip
                height={audioLaneHeight}
                gapBelow
                focused={focusedLane === 'audio'}
                onClickBackground={onLaneFocus ? () => onLaneFocus('audio') : undefined}
                onContextMenu={
                  onAudioContextMenu
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onAudioContextMenu(e.clientX, e.clientY);
                      }
                    : undefined
                }
              >
                <AudioLane
                  voiceoverUrl={voiceoverUrl}
                  totalDurationMs={totalDurationMs}
                  pixelsPerSecond={pixelsPerSecond}
                  height={audioLaneHeight}
                  onSeek={onSeek}
                />
              </LaneStrip>
              <LaneStrip
                height={CAPTIONS_LANE_HEIGHT}
                gapBelow
                focused={focusedLane === 'captions'}
                onClickBackground={onLaneFocus ? () => onLaneFocus('captions') : undefined}
              >
                <CaptionsLane
                  captions={captions}
                  totalDurationMs={totalDurationMs}
                  pixelsPerSecond={pixelsPerSecond}
                  height={CAPTIONS_LANE_HEIGHT}
                  playheadMs={playheadMs}
                  onSeek={onSeek}
                  onUpdateSegment={onUpdateCaption}
                  onContextMenu={onCaptionContextMenu}
                />
              </LaneStrip>
              <LaneStrip
                height={OVERLAYS_LANE_HEIGHT}
                focused={focusedLane === 'overlays'}
                onClickBackground={onLaneFocus ? () => onLaneFocus('overlays') : undefined}
              >
                <OverlaysLane
                  rows={doc.rows}
                  rowStartTimesMs={rowStartTimesMs}
                  rowOverlays={rowOverlays}
                  totalDurationMs={totalDurationMs}
                  pixelsPerSecond={pixelsPerSecond}
                  height={OVERLAYS_LANE_HEIGHT}
                  onSelect={onSelect}
                  onOpenPosition={onOpenOverlayPosition}
                  onContextMenu={onOverlayContextMenu}
                />
              </LaneStrip>
            </div>
          </div>

          {/* Playhead — single vertical line spanning every lane.
              The line itself is pointer-events-none so clicks pass
              through to the lanes underneath. The diamond head on top
              of the line is grabbable (pointer-events: auto) and
              dispatches onSeek on drag. Position is computed against
              the scroll container's scroll offset so it tracks even
              when the user scrolls without seeking. */}
          <PlayheadOverlay
            playheadX={playheadX}
            scrollRef={scrollRef}
            onSeek={onSeek}
            pixelsPerSecond={pixelsPerSecond}
            totalDurationMs={totalDurationMs}
          />
        </div>
      </div>
    </div>
  );
}

/** Left-column lane label. Mirrors the height + tint of its track-side
 *  counterpart so the rows align across the divider. `gapBelow` adds
 *  the LANE_GAP_PX margin under this label so the empty-strip gap
 *  matches the tracks column. `focused` highlights the label when its
 *  lane currently owns the inspector body. `onClick` (when provided)
 *  promotes the label to a clickable region — used to focus the lane
 *  from the label area as well as from the track area. */
function LaneLabel({
  height,
  label,
  tint,
  gapBelow = false,
  focused = false,
  onClick,
}: {
  height: number;
  label: string;
  tint?: 'purple' | 'cyan' | 'amber' | 'green';
  gapBelow?: boolean;
  focused?: boolean;
  onClick?: () => void;
}) {
  const tintBackground = tint
    ? {
        purple: 'var(--editor-lane-video)',
        cyan: 'var(--editor-lane-audio)',
        amber: 'var(--editor-lane-captions)',
        green: 'var(--editor-lane-overlays)',
      }[tint]
    : 'transparent';
  return (
    <div
      className="flex items-center px-2 text-[10px] uppercase tracking-wider"
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{
        height,
        background: tintBackground,
        color: focused ? 'var(--editor-accent)' : 'var(--fg-muted)',
        borderRadius: 4,
        marginBottom: gapBelow ? LANE_GAP_PX : 0,
        outline: focused ? '1px solid var(--editor-accent)' : '1px solid transparent',
        outlineOffset: -1,
        cursor: onClick ? 'pointer' : undefined,
      }}
      title={onClick ? `Open ${label.toLowerCase()} inspector` : undefined}
    >
      {label}
    </div>
  );
}

/** Right-column lane wrapper. Owns the rounded-corner / focused-outline
 *  visuals plus the inter-lane gap. Any click inside the strip routes
 *  to `onClickBackground` UNLESS a child called stopPropagation — this
 *  way the user gets the matching inspector tab as soon as they click
 *  anywhere in the lane, but a child that has its own meaning (e.g.
 *  a context-menu trigger) can opt out. Same bubble-routing applies
 *  to `onContextMenu` so right-clicking anywhere in the lane opens
 *  the lane's context menu (Phase 3); children that need their own
 *  right-click behavior (caption pill, overlay marker) stop
 *  propagation. */
function LaneStrip({
  height,
  gapBelow = false,
  focused = false,
  onClickBackground,
  onContextMenu,
  children,
}: {
  height: number;
  gapBelow?: boolean;
  focused?: boolean;
  onClickBackground?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClickBackground}
      onContextMenu={onContextMenu}
      style={{
        height,
        marginBottom: gapBelow ? LANE_GAP_PX : 0,
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
        outline: focused ? '1px solid var(--editor-accent)' : '1px solid transparent',
        outlineOffset: -1,
      }}
    >
      {children}
    </div>
  );
}

function PlayheadOverlay({
  playheadX,
  scrollRef,
  onSeek,
  pixelsPerSecond,
  totalDurationMs,
}: {
  playheadX: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onSeek: (ms: number) => void;
  pixelsPerSecond: number;
  totalDurationMs: number;
}) {
  // Re-read scrollLeft on every render so the line tracks the
  // visible window. We don't need a state subscription — the
  // parent re-renders on playheadMs anyway, and scroll happens to
  // be synchronous on the same element.
  const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
  const left = playheadX - scrollLeft;
  const viewportWidth = scrollRef.current?.clientWidth ?? 0;
  const isOffScreen = left < 0 || left > viewportWidth;

  // Track drag state across pointer events. A ref (not state) so the
  // value sticks without triggering re-renders we don't need — the
  // parent already re-renders on every playheadMs update during the
  // drag (via onSeek → seek → playheadMs change).
  const draggingRef = useRef(false);

  // Keep the element mounted while the user is mid-drag, even if they
  // scrub past the viewport edge. Once they let go, the off-screen
  // branch unmounts as before.
  if (isOffScreen && !draggingRef.current) {
    return null;
  }

  const xToMs = (clientX: number): number => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return 0;
    const rect = scrollEl.getBoundingClientRect();
    const xInScroll = clientX - rect.left + scrollEl.scrollLeft;
    const ms = (xInScroll / pixelsPerSecond) * 1000;
    return Math.max(0, Math.min(totalDurationMs, ms));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    console.info('[playhead scrub] start', {
      atMs: (playheadX / pixelsPerSecond) * 1000,
      pointerId: e.pointerId,
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const ms = xToMs(e.clientX);
    onSeek(ms);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released (e.g., pointercancel followed by pointerup).
    }
    draggingRef.current = false;
    console.info('[playhead scrub] end', {
      atMs: (playheadX / pixelsPerSecond) * 1000,
    });
  };

  return (
    <div
      aria-hidden
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{
        left,
        width: 1,
        background: 'var(--editor-playhead)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
      }}
    >
      {/* Grabbable head. Sits above the line, slightly wider than the
          line so it's an easy mouse target. pointer-events: auto
          overrides the line's parent-level pointer-events: none. */}
      <div
        role="slider"
        aria-label="Timeline playhead — drag to seek"
        aria-valuemin={0}
        aria-valuemax={totalDurationMs}
        aria-valuenow={Math.round((playheadX / pixelsPerSecond) * 1000)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'absolute',
          top: -2,
          left: -6,
          width: 13,
          height: 12,
          background: 'var(--editor-playhead)',
          // Pentagon: flat top, pointed bottom — reads as "play head"
          // pointing down at the line below.
          clipPath: 'polygon(0% 0%, 100% 0%, 100% 60%, 50% 100%, 0% 60%)',
          cursor: 'ew-resize',
          pointerEvents: 'auto',
          touchAction: 'none',
          boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
        }}
      />
    </div>
  );
}

