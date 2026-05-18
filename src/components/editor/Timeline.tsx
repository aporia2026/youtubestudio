'use client';

/**
 * Shot-graph editor — timeline strip skeleton.
 *
 * Phase 2 foundation of `_plans/2026-05-18-shot-graph-editor.md`.
 * Renders the project's shots as cards laid out in playback order,
 * widths proportional to `durationMs`, with thumbnails + duration
 * labels. Clicking a card selects it (dispatches SET_SELECTION);
 * the playhead position is reflected as a vertical bar overlaid on
 * the strip.
 *
 * Phase 2 per-command commits layer their UI on top:
 *
 *   – resize:  trailing-edge drag handle (this file gets a hover
 *              region + drag pointer; the command dispatch lives
 *              in the trim-shot commit)
 *   – split:   playhead-anchored "split here" button on hover
 *   – delete:  contextual menu on the card
 *   – reorder: @dnd-kit/sortable wraps the strip; this file gains
 *              a `<SortableContext>` boundary in that commit
 *   – mute:    a small toggle in the card's top-right
 *
 * This file ships with the strip + cards + selection wiring only.
 * No editing affordances yet — those are deliberately one-per-commit
 * to keep blast-radius tiny.
 */
import { useMemo } from 'react';
import type { VideoConfig, VideoShot } from '@/remotion/types';

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
  /** Optional: pixels per second. Default 80 — readable at standard
   *  shot lengths (4-15s). Phase 2 zoom controls bind this. */
  pixelsPerSecond?: number;
}

const DEFAULT_PX_PER_SECOND = 80;
const STRIP_HEIGHT = 96;
const MIN_CARD_WIDTH = 60;

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

export function Timeline({
  config,
  rowImages,
  selection,
  playheadMs,
  onSelect,
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

  return (
    <div
      className="relative w-full overflow-x-auto overflow-y-hidden rounded-lg border"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--card-bg)',
      }}
    >
      <div
        className="relative flex items-stretch"
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
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelect(idx)}
              className="relative shrink-0 group focus:outline-none"
              style={{
                width: widthPx,
                borderRight: idx === config.shots.length - 1 ? 'none' : '1px solid var(--card-border)',
              }}
              aria-pressed={isSelected}
              aria-label={`Select shot ${idx + 1}: ${shotLabel(shot, idx)}`}
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
                className="absolute inset-0 transition-colors"
                style={{
                  background: isSelected
                    ? 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.35) 50%, rgba(99,102,241,0.25) 100%)'
                    : 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.15) 60%, transparent 100%)',
                }}
              />
              <div className="absolute inset-0 flex flex-col justify-between p-1.5 text-left">
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
                    {formatMs(shot.durationMs)}
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
            </button>
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
