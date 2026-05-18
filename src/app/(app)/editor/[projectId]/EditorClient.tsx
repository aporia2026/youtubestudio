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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import {
  productionDocToVideoConfig,
  type ProductionDoc,
  type RowImageState,
} from '@/remotion/utils';
import { initialEditorState } from '@/lib/editor/store';
import { useEditorStore } from '@/lib/editor/use-editor-store';
import { Timeline } from '@/components/editor/Timeline';

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

export default function EditorClient({ projectId, version, payload }: EditorClientProps) {
  const parsed = useMemo(() => parsePayload(payload), [payload]);
  const doc = parsed?.doc;
  const rowImages = useMemo(() => parsed?.rowImages ?? {}, [parsed]);

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

      {saveStatus.kind === 'conflict' && (
        <ConflictBanner onReload={() => { void reloadFromServer(); }} />
      )}

      <div
        className="rounded-lg overflow-hidden border"
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

      <Timeline
        config={videoConfig}
        rowImages={state.rowImages}
        selection={state.selection}
        playheadMs={state.playheadMs}
        onSelect={(shotIndex) => apply({ type: 'SET_SELECTION', shotIndex })}
      />

      <div
        className="p-3 rounded-lg border text-xs"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
      >
        <strong style={{ color: 'var(--fg)' }}>Foundation in place.</strong> Editing commands
        (trim, split, delete, reorder, mute) land in follow-up commits per the plan&apos;s
        per-command cadence. Selection + playhead + undo / redo / save plumbing are wired
        and ready.
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
