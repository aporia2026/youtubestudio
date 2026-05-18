'use client';

/**
 * Doc-level text overlay manager — Phase 4 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Lists every TextOverlay on the current doc and exposes add /
 * edit / delete actions. The editor's store handles the actual
 * persistence; this component is the management surface.
 *
 * Add-overlay defaults: starts at the current playhead, 3 s long,
 * lower-third position. The user tweaks from there.
 */
import { useCallback, useMemo, useState } from 'react';
import type { TextOverlay } from '@/remotion/types';

interface TextOverlayManagerProps {
  overlays: TextOverlay[];
  /** Used to default the start time of newly-added overlays. */
  playheadMs: number;
  /** Total video duration in ms — used to clamp newly-added overlays
   *  to a sensible end time. */
  totalDurationMs: number;
  onClose: () => void;
  onAdd: (overlay: TextOverlay) => void;
  onUpdate: (id: string, patch: Partial<Omit<TextOverlay, 'id'>>) => void;
  onDelete: (id: string) => void;
}

const DEFAULT_OVERLAY_DURATION_MS = 3000;
const POSITIONS: Array<TextOverlay['position']> = ['lower-third', 'top-center'];

function generateId(): string {
  // Match the lightweight per-row id style used elsewhere — no crypto
  // dependency, sufficient uniqueness for client-side overlay ids.
  return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmt(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = (totalSeconds - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

export function TextOverlayManager({
  overlays,
  playheadMs,
  totalDurationMs,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
}: TextOverlayManagerProps): React.ReactElement {
  const sortedOverlays = useMemo(
    () => [...overlays].sort((a, b) => a.startMs - b.startMs),
    [overlays],
  );

  const handleAdd = useCallback(() => {
    const startMs = Math.max(0, playheadMs);
    const endMs = Math.min(totalDurationMs || startMs + DEFAULT_OVERLAY_DURATION_MS, startMs + DEFAULT_OVERLAY_DURATION_MS);
    onAdd({
      id: generateId(),
      text: 'New overlay',
      startMs,
      endMs,
      position: 'lower-third',
      fontSizeFraction: 0.045,
      color: '#ffffff',
      backgroundOpacity: 0.85,
      fadeInMs: 250,
    });
  }, [onAdd, playheadMs, totalDurationMs]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.65)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="rounded-lg border max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Text overlay manager"
      >
        <header
          className="px-5 py-4 flex items-center justify-between border-b"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <div>
            <div className="text-sm font-semibold">Text overlays</div>
            <div className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
              {sortedOverlays.length} overlay{sortedOverlays.length === 1 ? '' : 's'} · doc-level
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAdd}
              className="text-xs px-3 py-1.5 rounded border transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--accent-purple-bright, #a78bfa)', color: 'var(--accent-purple-bright, #a78bfa)' }}
            >
              + Add overlay
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2 py-1.5 rounded border hover:bg-white/5 transition-colors"
              style={{ borderColor: 'var(--card-border)' }}
            >
              Close
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {sortedOverlays.length === 0 ? (
            <div className="p-8 text-center text-sm" style={{ color: 'var(--fg-muted)' }}>
              No overlays yet. Click <strong style={{ color: 'var(--fg)' }}>+ Add overlay</strong> to
              create one at the current playhead.
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--card-border)' }}>
              {sortedOverlays.map((overlay) => (
                <OverlayRow
                  key={overlay.id}
                  overlay={overlay}
                  totalDurationMs={totalDurationMs}
                  onUpdate={(patch) => onUpdate(overlay.id, patch)}
                  onDelete={() => onDelete(overlay.id)}
                />
              ))}
            </div>
          )}
        </div>

        <footer
          className="px-5 py-3 border-t text-[11px]"
          style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
        >
          Doc-level overlays sit on top of every shot in their time window. For per-shot
          text, edit the row&apos;s <code>on_screen_text</code> in the inspector instead.
        </footer>
      </div>
    </div>
  );
}

interface OverlayRowProps {
  overlay: TextOverlay;
  totalDurationMs: number;
  onUpdate: (patch: Partial<Omit<TextOverlay, 'id'>>) => void;
  onDelete: () => void;
}

function OverlayRow({ overlay, totalDurationMs, onUpdate, onDelete }: OverlayRowProps): React.ReactElement {
  // Local-draft pattern: text + numeric fields commit on blur so the
  // store isn't dirty-flagged on every keystroke.
  const [textDraft, setTextDraft] = useState(overlay.text);
  const [startDraft, setStartDraft] = useState(String(overlay.startMs / 1000));
  const [endDraft, setEndDraft] = useState(String(overlay.endMs / 1000));

  const commitText = useCallback(() => {
    if (textDraft !== overlay.text) onUpdate({ text: textDraft });
  }, [overlay.text, onUpdate, textDraft]);

  const commitTimes = useCallback(() => {
    const startMs = Math.max(0, Math.round(Number(startDraft) * 1000));
    const endMs = Math.min(
      totalDurationMs || startMs + 500,
      Math.max(startMs + 500, Math.round(Number(endDraft) * 1000)),
    );
    if (startMs !== overlay.startMs || endMs !== overlay.endMs) {
      onUpdate({ startMs, endMs });
    }
  }, [endDraft, overlay.endMs, overlay.startMs, onUpdate, startDraft, totalDurationMs]);

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-start gap-2">
        <textarea
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
          onBlur={commitText}
          className="flex-1 text-xs rounded border p-2 resize-y min-h-[60px]"
          style={{
            borderColor: 'var(--card-border)',
            background: 'var(--bg)',
            color: 'var(--fg)',
          }}
          placeholder="Overlay text…"
        />
        <button
          type="button"
          onClick={onDelete}
          className="text-xs px-2 py-1.5 rounded border transition-colors hover:bg-white/5"
          style={{ borderColor: '#f87171', color: '#f87171' }}
          title="Delete this overlay"
        >
          Delete
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-xs" style={{ color: 'var(--fg-muted)' }}>
        <label className="flex items-center gap-1">
          <span>Start</span>
          <input
            type="number"
            step={0.1}
            min={0}
            value={startDraft}
            onChange={(e) => setStartDraft(e.target.value)}
            onBlur={commitTimes}
            className="w-16 text-xs rounded border px-1 py-0.5 tabular-nums"
            style={{ borderColor: 'var(--card-border)', background: 'var(--bg)', color: 'var(--fg)' }}
          />
        </label>
        <label className="flex items-center gap-1">
          <span>End</span>
          <input
            type="number"
            step={0.1}
            min={0}
            value={endDraft}
            onChange={(e) => setEndDraft(e.target.value)}
            onBlur={commitTimes}
            className="w-16 text-xs rounded border px-1 py-0.5 tabular-nums"
            style={{ borderColor: 'var(--card-border)', background: 'var(--bg)', color: 'var(--fg)' }}
          />
        </label>
        <span className="tabular-nums">
          {fmt(overlay.startMs)} → {fmt(overlay.endMs)}
        </span>

        <label className="flex items-center gap-1">
          <span>Position</span>
          <select
            value={overlay.position}
            onChange={(e) => onUpdate({ position: e.target.value as TextOverlay['position'] })}
            className="text-xs rounded border px-1 py-0.5"
            style={{ borderColor: 'var(--card-border)', background: 'var(--bg)', color: 'var(--fg)' }}
          >
            {POSITIONS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span>Color</span>
          <input
            type="color"
            value={overlay.color ?? '#ffffff'}
            onChange={(e) => onUpdate({ color: e.target.value })}
            className="w-6 h-5 rounded border cursor-pointer"
            style={{ borderColor: 'var(--card-border)' }}
          />
        </label>

        <label className="flex items-center gap-1">
          <span>Size</span>
          <input
            type="number"
            step={0.01}
            min={0.02}
            max={0.12}
            value={overlay.fontSizeFraction ?? 0.045}
            onChange={(e) => onUpdate({ fontSizeFraction: Math.max(0.02, Math.min(0.12, Number(e.target.value))) })}
            className="w-16 text-xs rounded border px-1 py-0.5 tabular-nums"
            style={{ borderColor: 'var(--card-border)', background: 'var(--bg)', color: 'var(--fg)' }}
          />
        </label>
      </div>
    </div>
  );
}
