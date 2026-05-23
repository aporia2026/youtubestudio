'use client';

/**
 * Captions lane — Phase 5 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Renders each caption segment as a rounded pill positioned by its
 * timing. Click selects the pill (drives the inspector's Captions
 * tab); double-click opens an inline editor right on the pill so
 * the user can edit caption text without leaving the timeline —
 * per the resolved open-question in the plan.
 *
 * Inline edit commits on blur or Enter; Escape cancels. The
 * commit callback fires with the new text; the parent dispatches
 * the right command so the canonical payload picks it up.
 */

import { useState, useEffect, useRef } from 'react';
import type { CaptionsBundle, CaptionSegment } from '@/lib/editor/captions';

interface CaptionsLaneProps {
  captions: CaptionsBundle | undefined;
  totalDurationMs: number;
  pixelsPerSecond: number;
  height: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  onUpdateSegment: (index: number, text: string) => void;
  /** Phase 3: right-click a caption pill. Fires with the segment
   *  index + viewport coords. The pill stops propagation so the
   *  parent LaneStrip doesn't also receive the contextmenu event. */
  onContextMenu?: (segmentIndex: number, x: number, y: number) => void;
}

export function CaptionsLane({
  captions,
  totalDurationMs,
  pixelsPerSecond,
  height,
  playheadMs,
  onSeek,
  onUpdateSegment,
  onContextMenu,
}: CaptionsLaneProps): React.ReactElement {
  const widthPx = Math.max(100, Math.round((totalDurationMs / 1000) * pixelsPerSecond));
  const segments = captions?.segments ?? [];

  if (segments.length === 0) {
    return (
      <div
        className="flex items-center px-3"
        style={{
          height,
          background: 'var(--editor-lane-captions)',
          color: 'var(--fg-muted)',
          fontSize: 10,
          minWidth: widthPx,
        }}
      >
        No captions — generate from AI Tools
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{
        height,
        background: 'var(--editor-lane-captions)',
        minWidth: widthPx,
        width: widthPx,
      }}
    >
      {segments.map((seg, i) => (
        <CaptionPill
          key={i}
          segment={seg}
          isActive={playheadMs >= seg.start * 1000 && playheadMs < seg.end * 1000}
          pixelsPerSecond={pixelsPerSecond}
          height={height}
          onSeek={() => onSeek(Math.round(seg.start * 1000))}
          onCommit={(text) => onUpdateSegment(i, text)}
          onContextMenu={
            onContextMenu
              ? (x, y) => onContextMenu(i, x, y)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function CaptionPill({
  segment,
  isActive,
  pixelsPerSecond,
  height,
  onSeek,
  onCommit,
  onContextMenu,
}: {
  segment: CaptionSegment;
  isActive: boolean;
  pixelsPerSecond: number;
  height: number;
  onSeek: () => void;
  onCommit: (text: string) => void;
  onContextMenu?: (x: number, y: number) => void;
}): React.ReactElement {
  const left = segment.start * pixelsPerSecond;
  const width = Math.max(20, (segment.end - segment.start) * pixelsPerSecond);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(segment.text);
  }, [segment.text]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== segment.text) {
      console.info('[editor captions-lane] commit', {
        prevLen: segment.text.length,
        newLen: draft.length,
      });
      onCommit(draft);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(segment.text);
  };

  return (
    <div
      className="absolute rounded-md overflow-hidden flex items-center px-2"
      style={{
        left,
        top: 4,
        width,
        height: height - 8,
        background: isActive ? 'rgba(245, 158, 11, 0.55)' : 'rgba(245, 158, 11, 0.22)',
        border: '1px solid',
        borderColor: isActive ? '#f59e0b' : 'rgba(245, 158, 11, 0.5)',
        cursor: editing ? 'text' : 'pointer',
      }}
      onClick={(e) => {
        if (editing) return;
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      title={editing ? 'Editing — Enter to save, Escape to cancel' : 'Click to seek, double-click to edit (right-click for options)'}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className="w-full bg-transparent border-none outline-none text-[10px]"
          style={{ color: 'var(--fg)' }}
        />
      ) : (
        <span
          className="text-[10px] truncate"
          style={{ color: 'var(--fg)' }}
        >
          {segment.text}
        </span>
      )}
    </div>
  );
}
