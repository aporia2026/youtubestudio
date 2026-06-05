'use client';

/**
 * Settings → Timeline Editor preferences panel.
 *
 * Surfaces the four per-device timeline-editor preference keys
 * defined in `src/lib/timeline-editor/editor-prefs.ts`:
 *
 *   - FPS for frame snap (24 / 30 / 60)
 *   - Snap to frame (on/off)
 *   - Undo buffer depth (20 / 50 / 100)
 *   - Default zoom in px/sec (500 / 200 / 100 / 50 / 20 / 10 / 5)
 *
 * Mirrors the existing EditorPrefsPanel pattern: localStorage,
 * SSR-safe accessors, no Save button, every change writes through.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M5 polish).
 */

import { useEffect, useState } from 'react';
import {
  ALLOWED_FPS,
  ALLOWED_UNDO_DEPTH,
  ALLOWED_ZOOM_MS_PER_PX,
  getTimelineDefaultZoomMsPerPx,
  getTimelineFps,
  getTimelineSnap,
  getTimelineUndoDepth,
  setTimelineDefaultZoomMsPerPx,
  setTimelineFps,
  setTimelineSnap,
  setTimelineUndoDepth,
  type AllowedFps,
  type AllowedUndoDepth,
  type AllowedZoomMsPerPx,
} from '@/lib/timeline-editor/editor-prefs';

export function TimelineEditorPrefsPanel() {
  const [fps, setFps] = useState<AllowedFps>(30);
  const [snap, setSnap] = useState(true);
  const [undoDepth, setUndoDepth] = useState<AllowedUndoDepth>(50);
  const [zoom, setZoom] = useState<AllowedZoomMsPerPx>(10);

  useEffect(() => {
    setFps(getTimelineFps());
    setSnap(getTimelineSnap());
    setUndoDepth(getTimelineUndoDepth());
    setZoom(getTimelineDefaultZoomMsPerPx());
  }, []);

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-base font-medium text-neutral-100">Timeline editor</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Per-device preferences for the CapCut-style timeline at <code className="rounded bg-neutral-900 px-1 py-0.5 text-[10px]">/timeline-editor</code>.
          Defaults are sane; tweak only if the editor doesn't feel right.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Frame rate" hint="Used for frame-snap on every drag, split, and cut.">
          <select
            value={fps}
            onChange={(e) => {
              const v = Number(e.target.value) as AllowedFps;
              setFps(v);
              setTimelineFps(v);
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          >
            {ALLOWED_FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </Field>

        <Field label="Default zoom" hint="Pixels per second on first load. CapCut default is 100.">
          <select
            value={zoom}
            onChange={(e) => {
              const v = Number(e.target.value) as AllowedZoomMsPerPx;
              setZoom(v);
              setTimelineDefaultZoomMsPerPx(v);
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          >
            {ALLOWED_ZOOM_MS_PER_PX.map((m) => <option key={m} value={m}>{(1000 / m).toFixed(0)} px/sec</option>)}
          </select>
        </Field>

        <Field label="Undo depth" hint="How many edits the undo stack remembers.">
          <select
            value={undoDepth}
            onChange={(e) => {
              const v = Number(e.target.value) as AllowedUndoDepth;
              setUndoDepth(v);
              setTimelineUndoDepth(v);
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          >
            {ALLOWED_UNDO_DEPTH.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>

        <Field label="Snap to frame" hint="Drag-trim and split snap to the nearest frame at the chosen fps.">
          <label className="flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100">
            <input
              type="checkbox"
              checked={snap}
              onChange={(e) => {
                setSnap(e.target.checked);
                setTimelineSnap(e.target.checked);
              }}
            />
            <span className="text-xs">{snap ? 'On' : 'Off'}</span>
          </label>
        </Field>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-xs font-medium text-neutral-300">{label}</span>
      {children}
      <span className="block text-[10px] text-neutral-500">{hint}</span>
    </label>
  );
}
