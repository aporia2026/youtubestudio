/**
 * Per-device preferences for the CapCut-style timeline editor.
 * Stored in localStorage so they survive refresh without a server
 * round-trip — these are viewing preferences, not project data.
 *
 * Every accessor is SSR-safe (returns the default when window is
 * unreachable) so server components can read them at compile time
 * without crashing.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M5 polish).
 */

import { DEFAULT_FPS } from './frame-math';
import { DEFAULT_HISTORY_DEPTH } from './doc-history';

const KEY_FPS = 'timeline-editor.fps';
const KEY_SNAP = 'timeline-editor.snap';
const KEY_UNDO_DEPTH = 'timeline-editor.undoDepth';
const KEY_DEFAULT_ZOOM_MS_PER_PX = 'timeline-editor.defaultZoomMsPerPx';

export const ALLOWED_FPS = [24, 30, 60] as const;
export const ALLOWED_UNDO_DEPTH = [20, 50, 100] as const;
/** Mirrors the zoom-level stops in TimelineEditor.tsx. */
export const ALLOWED_ZOOM_MS_PER_PX = [2, 5, 10, 20, 50, 100, 200] as const;
export const DEFAULT_ZOOM_MS_PER_PX = 10;

export type AllowedFps = (typeof ALLOWED_FPS)[number];
export type AllowedUndoDepth = (typeof ALLOWED_UNDO_DEPTH)[number];
export type AllowedZoomMsPerPx = (typeof ALLOWED_ZOOM_MS_PER_PX)[number];

function readLocal(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / private-mode — silent */
  }
}

export function getTimelineFps(): AllowedFps {
  const raw = readLocal(KEY_FPS);
  const parsed = raw ? Number(raw) : NaN;
  if ((ALLOWED_FPS as readonly number[]).includes(parsed)) return parsed as AllowedFps;
  return DEFAULT_FPS as AllowedFps;
}

export function setTimelineFps(value: AllowedFps): void {
  writeLocal(KEY_FPS, String(value));
}

export function getTimelineSnap(): boolean {
  const raw = readLocal(KEY_SNAP);
  if (raw === '0' || raw === 'false') return false;
  return true; // default on
}

export function setTimelineSnap(value: boolean): void {
  writeLocal(KEY_SNAP, value ? '1' : '0');
}

export function getTimelineUndoDepth(): AllowedUndoDepth {
  const raw = readLocal(KEY_UNDO_DEPTH);
  const parsed = raw ? Number(raw) : NaN;
  if ((ALLOWED_UNDO_DEPTH as readonly number[]).includes(parsed)) return parsed as AllowedUndoDepth;
  return DEFAULT_HISTORY_DEPTH as AllowedUndoDepth;
}

export function setTimelineUndoDepth(value: AllowedUndoDepth): void {
  writeLocal(KEY_UNDO_DEPTH, String(value));
}

export function getTimelineDefaultZoomMsPerPx(): AllowedZoomMsPerPx {
  const raw = readLocal(KEY_DEFAULT_ZOOM_MS_PER_PX);
  const parsed = raw ? Number(raw) : NaN;
  if ((ALLOWED_ZOOM_MS_PER_PX as readonly number[]).includes(parsed)) return parsed as AllowedZoomMsPerPx;
  return DEFAULT_ZOOM_MS_PER_PX;
}

export function setTimelineDefaultZoomMsPerPx(value: AllowedZoomMsPerPx): void {
  writeLocal(KEY_DEFAULT_ZOOM_MS_PER_PX, String(value));
}
