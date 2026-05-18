'use client';

/**
 * Shot-graph editor client — Phase 2 foundation.
 *
 * Wires:
 *   – persisted ProductionDoc + rowImages from the server props
 *   – the Zustand-style store (`useEditorStore`) with auto-save
 *   – Remotion `<Player>` with memoized inputProps
 *   – Timeline strip showing every shot card
 *   – Save status indicator + manual Save button
 *   – Conflict toast offering Reload when the server rejects a save
 *   – Undo / Redo buttons (Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z also work
 *     via window-scoped listeners inside the hook)
 *
 * Per-command commits land their UI on top of this scaffold — the
 * timeline strip + side panel are the surfaces every command paints
 * onto. This commit ships ZERO editing commands (the store's
 * editing-command catalog is empty); the user can preview, scrub,
 * select a shot, undo / redo (no-ops with empty stacks), and manually
 * save (no-op since `isDirty` is always false until a command lands).
 *
 * Memoization rules (per the resolution of Q2 — `@remotion/player`
 * supports live `inputProps` updates without remount when the
 * reference is stable). All derived values use `useMemo` so the
 * player composition re-renders cheaply.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import {
  productionDocToVideoConfig,
  type ProductionDoc,
  type RowImageState,
} from '@/remotion/utils';
import {
  EDITOR_MIN_SHOT_MS,
  initialEditorState,
  rowStartTimesMs,
} from '@/lib/editor/store';
import { useEditorStore } from '@/lib/editor/use-editor-store';
import { Timeline } from '@/components/editor/Timeline';
import { ShotInspector } from '@/components/editor/ShotInspector';

interface EditorClientProps {
  projectId: string;
  version: number;
  /** Raw `user_history.payload` JSONB. Parsed defensively because
   *  the column is `JSONB` server-side; old rows from before recent
   *  doc-shape additions may be missing fields. */
  payload: unknown;
}

interface HistoryPayload {
  doc?: ProductionDoc;
  rowImages?: Record<number, string>;
  title?: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parsePayload(payload: unknown): HistoryPayload | null {
  if (!isPlainObject(payload)) return null;
  const doc = isPlainObject(payload.doc) ? (payload.doc as unknown as ProductionDoc) : undefined;
  if (!doc || !Array.isArray((doc as ProductionDoc).rows)) return null;
  const rowImages = isPlainObject(payload.rowImages)
    ? (payload.rowImages as Record<number, string>)
    : {};
  const title = typeof payload.title === 'string' ? payload.title : undefined;
  return { doc, rowImages, title };
}

function relativeTimeShort(thenMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - thenMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const PLACEHOLDER_DOC: ProductionDoc = {
  rows: [],
  title: '',
  niche: '',
  total_duration: '0',
  total_words: 0,
  speaking_pace_wpm: 150,
};

/** Timeline zoom — integer levels 1..10 (plan's `+`/`-` range).
 *  Levels map to px/sec geometrically so each step feels like the
 *  same proportional zoom: level 1 = 16 px/s (whole videos fit on
 *  screen), level 5 ≈ 94 px/s (the default), level 10 = 800 px/s
 *  (frame-level precision for trim drags). */
const ZOOM_MIN_LEVEL = 1;
const ZOOM_MAX_LEVEL = 10;
const ZOOM_DEFAULT_LEVEL = 5;
const ZOOM_STEP = 1;

function zoomLevelToPxPerSecond(level: number): number {
  const t = (level - ZOOM_MIN_LEVEL) / (ZOOM_MAX_LEVEL - ZOOM_MIN_LEVEL);
  return Math.round(16 * Math.pow(800 / 16, t));
}

export default function EditorClient({ projectId, version, payload }: EditorClientProps) {
  const parsed = useMemo(() => parsePayload(payload), [payload]);
  const doc = parsed?.doc;
  const rowImages = useMemo(() => parsed?.rowImages ?? {}, [parsed]);

  // Timeline zoom. Lives in the client because zoom is a viewing
  // preference, not part of the doc; we deliberately don't persist
  // it across reloads in v1.
  const [zoomLevel, setZoomLevel] = useState(ZOOM_DEFAULT_LEVEL);
  const pixelsPerSecond = useMemo(() => zoomLevelToPxPerSecond(zoomLevel), [zoomLevel]);
  const handleZoomDelta = useCallback((delta: number) => {
    setZoomLevel((prev) =>
      Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, prev + delta)),
    );
  }, []);

  // Hooks run unconditionally; conditional render via early return AFTER
  // the hooks declare their values.
  const store = useEditorStore(
    initialEditorState({
      doc: doc ?? PLACEHOLDER_DOC,
      rowImages,
      version,
    }),
    projectId,
  );
  const { state, apply, flushSave, reloadFromServer, saveStatus, canUndo, canRedo } = store;

  // Derive the VideoConfig the player will render. Memoized so the
  // Remotion player's inputProps reference is stable across renders
  // that don't touch the doc.
  const videoConfig = useMemo(() => {
    if (!doc) return null;
    const rowImageArr: (RowImageState | null)[] = state.doc.rows.map((_, i) => {
      const url = state.rowImages[i];
      return url ? { status: 'ready', imageUrl: url } : null;
    });
    return productionDocToVideoConfig(state.doc, rowImageArr, {});
  }, [doc, state.doc, state.rowImages]);

  const inputProps = useMemo(() => (videoConfig ? { config: videoConfig } : null), [videoConfig]);

  const totalFrames = useMemo(() => {
    if (!videoConfig) return 1;
    const totalMs = videoConfig.shots.reduce((acc, s) => acc + s.durationMs, 0);
    return Math.max(1, Math.round((totalMs / 1000) * videoConfig.fps));
  }, [videoConfig]);

  // Per-shot trim values pulled off the doc rows — handed to the
  // Timeline so the head / tail handles draw at the right offsets.
  const rowTrims = useMemo(() => {
    const out: Record<number, { trimStartMs?: number; trimEndMs?: number }> = {};
    state.doc.rows.forEach((row, i) => {
      if (typeof row.trim_start_ms === 'number' || typeof row.trim_end_ms === 'number') {
        out[i] = {
          trimStartMs: row.trim_start_ms,
          trimEndMs: row.trim_end_ms,
        };
      }
    });
    return out;
  }, [state.doc.rows]);

  // Resolve the playhead against the doc's cumulative shot timing
  // so the "split at playhead" path knows which shot to act on and
  // whether the split would produce two legal halves. Recomputed
  // whenever the doc OR the playhead position changes — both are
  // primitive snapshots so the memo deps are stable.
  const splitTarget = useMemo(() => {
    if (!doc) return null;
    const starts = rowStartTimesMs(state.doc);
    for (let i = 0; i < state.doc.rows.length; i++) {
      const row = state.doc.rows[i];
      const startMs = starts[i];
      const duration =
        typeof row.duration_override_ms === 'number'
          ? row.duration_override_ms
          : (i + 1 < starts.length ? starts[i + 1] - startMs : 0);
      const endMs = startMs + duration;
      if (state.playheadMs > startMs && state.playheadMs < endMs) {
        const offsetMs = state.playheadMs - startMs;
        const validSplit =
          offsetMs >= EDITOR_MIN_SHOT_MS && (duration - offsetMs) >= EDITOR_MIN_SHOT_MS;
        return { shotIndex: i, splitAtMs: offsetMs, validSplit };
      }
    }
    return null;
  }, [doc, state.doc, state.playheadMs]);

  const handleSplit = useCallback(() => {
    if (!splitTarget || !splitTarget.validSplit) return;
    apply({ type: 'SPLIT_SHOT', shotIndex: splitTarget.shotIndex, splitAtMs: splitTarget.splitAtMs });
  }, [apply, splitTarget]);

  const handleDelete = useCallback(
    (mode: 'ripple' | 'blank') => {
      if (state.selection === null) return;
      // Refuse to delete the last remaining shot — the reducer
      // also guards but we early-return here so the toolbar button
      // disables itself for the right reason.
      if (state.doc.rows.length <= 1) return;
      apply({ type: 'DELETE_SHOT', shotIndex: state.selection, mode });
    },
    [apply, state.doc.rows.length, state.selection],
  );

  const handleToggleMute = useCallback(() => {
    if (state.selection === null) return;
    const row = state.doc.rows[state.selection];
    if (!row) return;
    apply({ type: 'SET_MUTE', shotIndex: state.selection, muted: row.muted !== true });
  }, [apply, state.doc.rows, state.selection]);

  // Keyboard shortcuts:
  //   B          → split at playhead (CapCut / FCP blade)
  //   Delete     → ripple-delete selected shot
  //   Shift+Del  → blank-delete selected shot (keeps the slot)
  // All shortcuts are ignored when focus is in a text input so
  // typing in a future inline editor doesn't trigger them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      // Bail on modifier combos that belong to other handlers
      // (Cmd/Ctrl+Z, Cmd/Ctrl+S already bound at the store layer).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        handleSplit();
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        handleDelete(e.shiftKey ? 'blank' : 'ripple');
        return;
      }
      if (key === 'm') {
        e.preventDefault();
        handleToggleMute();
        return;
      }
      // Zoom: `+` / `=` zoom in; `-` zoom out. Matches the plan's
      // keyboard map and the muscle memory of every NLE.
      if (key === '+' || key === '=') {
        e.preventDefault();
        handleZoomDelta(ZOOM_STEP);
        return;
      }
      if (key === '-' || key === '_') {
        e.preventDefault();
        handleZoomDelta(-ZOOM_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDelete, handleSplit, handleToggleMute, handleZoomDelta]);

  // Subscribe to frame updates so the playhead reflects the live
  // play position. Throttled at the ms-rounded level so React only
  // re-renders the toolbar when the integer ms value changes.
  const playerRef = useRef<PlayerRef>(null);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !videoConfig) return;
    const fps = videoConfig.fps;
    let lastMs = -1;
    const onFrameUpdate = (e: { detail: { frame: number } }): void => {
      const ms = Math.round((e.detail.frame / fps) * 1000);
      if (ms === lastMs) return;
      lastMs = ms;
      apply({ type: 'SET_PLAYHEAD', ms });
    };
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate);
    };
  }, [videoConfig, apply]);

  if (!parsed || !doc || !inputProps || !videoConfig) {
    console.warn('[editor client] payload missing or unparseable', { projectId });
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-3">
        <h1 className="text-xl font-semibold">Couldn&apos;t load this project</h1>
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
          The production-doc row this URL points at is missing its <code>doc</code> payload,
          or its shape is older than the editor expects.
        </p>
        <Link href="/production-doc" className="text-sm underline">
          ← Back to Production Doc
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">
            {parsed.title || state.doc.title || 'Untitled project'}
          </h1>
          <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {state.doc.rows.length} shots · {state.doc.total_duration} · version {state.version}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <SaveStatusBadge status={saveStatus} isDirty={state.isDirty} />

          <button
            type="button"
            onClick={handleSplit}
            disabled={!splitTarget?.validSplit}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title={
              splitTarget?.validSplit
                ? `Split shot ${splitTarget.shotIndex + 1} at playhead (B)`
                : 'Move the playhead inside a shot to split it (B)'
            }
          >
            ✂ Split at playhead
          </button>

          <button
            type="button"
            onClick={() => handleDelete('ripple')}
            disabled={state.selection === null || state.doc.rows.length <= 1}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title={
              state.selection === null
                ? 'Select a shot to delete it (Delete)'
                : `Delete shot ${state.selection + 1} (Delete; Shift+Delete to keep the slot)`
            }
          >
            ✕ Delete
          </button>

          <button
            type="button"
            onClick={handleToggleMute}
            disabled={state.selection === null}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{
              borderColor: 'var(--card-border)',
              color:
                state.selection !== null && state.doc.rows[state.selection]?.muted
                  ? '#f87171'
                  : undefined,
            }}
            title={
              state.selection === null
                ? 'Select a shot to mute / unmute it (M)'
                : state.doc.rows[state.selection]?.muted
                  ? `Unmute shot ${state.selection + 1} (M)`
                  : `Mute shot ${state.selection + 1} (M)`
            }
          >
            {state.selection !== null && state.doc.rows[state.selection]?.muted
              ? 'Unmute'
              : 'Mute'}
          </button>

          <button
            type="button"
            onClick={() => apply({ type: 'UNDO' })}
            disabled={!canUndo}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Undo (Cmd/Ctrl+Z)"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            onClick={() => apply({ type: 'REDO' })}
            disabled={!canRedo}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Redo (Cmd/Ctrl+Shift+Z)"
          >
            ↷ Redo
          </button>
          <button
            type="button"
            onClick={() => { void flushSave(); }}
            disabled={!state.isDirty}
            className="text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{
              borderColor: state.isDirty ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--card-border)',
              color: state.isDirty ? 'var(--accent-purple-bright, #a78bfa)' : undefined,
            }}
            title="Save now (Cmd/Ctrl+S)"
          >
            Save
          </button>
          <Link
            href="/production-doc"
            className="text-sm px-3 py-1.5 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)' }}
          >
            ← Production Doc
          </Link>
        </div>
      </header>

      {/* Zoom strip — sits between the toolbar and the player so
          the slider visually belongs to the timeline below. */}
      <div className="flex items-center justify-end gap-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
        <span title="Zoom out (−)">−</span>
        <input
          type="range"
          min={ZOOM_MIN_LEVEL}
          max={ZOOM_MAX_LEVEL}
          step={1}
          value={zoomLevel}
          onChange={(e) => setZoomLevel(Number(e.target.value))}
          className="w-32"
          aria-label="Timeline zoom"
        />
        <span title="Zoom in (+)">+</span>
        <span className="tabular-nums w-10 text-right">{zoomLevel}×</span>
      </div>

      {saveStatus.kind === 'conflict' && (
        <ConflictBanner onReload={() => { void reloadFromServer(); }} />
      )}

      <div className="flex gap-4 items-start">
        <div
          className="rounded-lg overflow-hidden border flex-1 min-w-0"
          style={{ borderColor: 'var(--card-border)', background: '#000' }}
        >
          <Player
            ref={playerRef}
            component={YouTubeVideo}
            inputProps={inputProps}
            durationInFrames={totalFrames}
            compositionWidth={videoConfig.width}
            compositionHeight={videoConfig.height}
            fps={videoConfig.fps}
            controls
            style={{ width: '100%', aspectRatio: `${videoConfig.width} / ${videoConfig.height}` }}
            acknowledgeRemotionLicense
          />
        </div>

        {state.selection !== null && state.doc.rows[state.selection] && (
          <ShotInspector
            shotIndex={state.selection}
            shot={videoConfig.shots[state.selection]}
            row={state.doc.rows[state.selection]}
            thumbnailUrl={state.rowImages[state.selection] ?? null}
            totalShots={state.doc.rows.length}
            projectId={projectId}
            onClose={() => apply({ type: 'SET_SELECTION', shotIndex: null })}
            onUploadImage={(url) =>
              apply({ type: 'SET_ROW_IMAGE', shotIndex: state.selection as number, url })
            }
            onPickProjectClip={(url, durationSeconds) =>
              apply({
                type: 'SET_ROW_VIDEO',
                shotIndex: state.selection as number,
                url,
                durationSeconds,
              })
            }
          />
        )}
      </div>

      <Timeline
        config={videoConfig}
        rowImages={state.rowImages}
        selection={state.selection}
        playheadMs={state.playheadMs}
        rowTrims={rowTrims}
        pixelsPerSecond={pixelsPerSecond}
        onSelect={(shotIndex) => apply({ type: 'SET_SELECTION', shotIndex })}
        onResize={(shotIndex, durationMs) =>
          apply({ type: 'RESIZE_SHOT', shotIndex, durationMs })
        }
        onReorder={(fromIndex, toIndex) =>
          apply({ type: 'REORDER_SHOTS', fromIndex, toIndex })
        }
        onTrim={(shotIndex, values) =>
          apply({ type: 'TRIM_SHOT', shotIndex, ...values })
        }
      />

      <div
        className="p-3 rounded-lg border text-xs"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
      >
        <strong style={{ color: 'var(--fg)' }}>Resize</strong> drag the trailing edge.{' '}
        <strong style={{ color: 'var(--fg)' }}>Reorder</strong> drag the top grab handle.{' '}
        <strong style={{ color: 'var(--fg)' }}>Split</strong> press B at the playhead.{' '}
        <strong style={{ color: 'var(--fg)' }}>Delete</strong> select + Delete (ripple) or
        Shift+Delete (blank — keeps the slot).{' '}
        <strong style={{ color: 'var(--fg)' }}>Mute</strong> select + M.{' '}
        Cmd / Ctrl+Z undoes anything.
      </div>
    </div>
  );
}

// ─── Save-status badge ─────────────────────────────────────────────

interface SaveStatusBadgeProps {
  status: ReturnType<typeof useEditorStore>['saveStatus'];
  isDirty: boolean;
}

function SaveStatusBadge({ status, isDirty }: SaveStatusBadgeProps): React.ReactElement {
  // Re-tick once per second when we're displaying a relative time so
  // "Saved 4s ago" advances. Cheap — only mounts when status.kind ===
  // 'saved'.
  const [now, setNow] = useTick(status.kind === 'saved' ? 1000 : null);

  let label: string;
  let color: string;
  switch (status.kind) {
    case 'idle':
      label = isDirty ? 'Unsaved changes' : 'Saved';
      color = isDirty ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--fg-muted)';
      break;
    case 'pending':
      label = 'Saving…';
      color = 'var(--fg-muted)';
      break;
    case 'saving':
      label = 'Saving…';
      color = 'var(--fg-muted)';
      break;
    case 'saved':
      label = `Saved · ${relativeTimeShort(status.at, now)}`;
      color = 'var(--fg-muted)';
      break;
    case 'conflict':
      label = 'Conflict — see banner';
      color = '#f87171';
      break;
    case 'error':
      label = `Save error: ${status.message.slice(0, 50)}`;
      color = '#f87171';
      break;
  }

  // setNow is unused (the tick hook drives `now`); keep destructure
  // to silence the lint rule.
  void setNow;

  return (
    <span className="text-xs tabular-nums" style={{ color }}>
      {label}
    </span>
  );
}

/** Re-render every `intervalMs` ms. Pass `null` to pause. */
function useTick(intervalMs: number | null): [number, (n: number) => void] {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const handle = setInterval(() => setN(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return [n, setN];
}

// ─── Conflict banner ───────────────────────────────────────────────

function ConflictBanner({ onReload }: { onReload: () => void }): React.ReactElement {
  return (
    <div
      className="p-3 rounded-lg border flex items-center justify-between gap-3"
      style={{
        borderColor: '#f87171',
        background: 'rgba(248, 113, 113, 0.08)',
      }}
    >
      <div className="text-sm" style={{ color: '#fca5a5' }}>
        This project was edited elsewhere. Your unsaved changes will be lost.
      </div>
      <button
        type="button"
        onClick={onReload}
        className="text-xs px-3 py-1.5 rounded border transition-colors hover:bg-white/5"
        style={{ borderColor: '#f87171', color: '#fca5a5' }}
      >
        Reload from server
      </button>
    </div>
  );
}
