'use client';

/**
 * React adapter for the shot-graph editor store.
 *
 * Wraps `applyCommand` (pure logic in `./store.ts`) in a `useReducer`
 * so consumers can dispatch commands ergonomically. The adapter also
 * owns the auto-save lifecycle: when `isDirty` flips to true, it
 * schedules a debounced PATCH; when the user hits Cmd/Ctrl+S, it
 * cancels the debounce and saves immediately.
 *
 * If/when Phase 2's cross-component access needs grow beyond what
 * context-via-hook gives us, swap the internals to Zustand without
 * changing the consumer surface. That's why callers should always
 * import this hook, never `useReducer` + `applyCommand` directly.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { applyCommand, persistableFromState, type EditorCommand, type EditorState } from './store';
import { saveEditorPayload, type SaveResult } from './save-client';
import { isGestureActive } from './gesture-state';
import {
  broadcastChannelName,
  decideBroadcastAction,
  newTabId,
  type ProjectPatchedBroadcast,
} from '@/lib/project/broadcast-sync';

const AUTO_SAVE_DEBOUNCE_MS = 800;

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' } // debounce timer running, no PATCH in flight yet
  | { kind: 'saving' } // PATCH in flight
  | { kind: 'saved'; at: number }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

export interface UseEditorStoreReturn {
  state: EditorState;
  apply: (cmd: EditorCommand) => void;
  /** Force an immediate save, cancelling any pending debounce. */
  flushSave: () => Promise<SaveResult | null>;
  /** Reload from server — used by the conflict-recovery toast. */
  reloadFromServer: () => Promise<void>;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
}

export interface UseEditorStoreOptions {
  /**
   * Fires synchronously AFTER a successful apply (including the
   * internal keyboard-driven UNDO/REDO path). Receives the original
   * command. For UNDO / REDO, also receives the underlying command
   * that was popped off the stack — caller can inspect it to wire
   * structural side-effects (e.g. propagate an insert/delete to a
   * server-side `project_assets` table). Pre-dispatch state snapshot
   * is exposed via `prevState` so the caller can read the stack tops
   * that were just consumed without re-deriving from the new state.
   */
  onAfterCommand?: (info: {
    cmd: EditorCommand;
    resolvedInner: EditorCommand | null;
    prevState: EditorState;
  }) => void;
}

export function useEditorStore(
  initial: EditorState,
  projectId: string,
  options: UseEditorStoreOptions = {},
): UseEditorStoreReturn {
  const [state, dispatch] = useReducer(
    (s: EditorState, cmd: EditorCommand) => applyCommand(s, cmd),
    initial,
  );

  const onAfterCommandRef = useRef(options.onAfterCommand);
  onAfterCommandRef.current = options.onAfterCommand;

  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

  // Refs that need to stay current for the debounce closure without
  // re-creating the timer on every dispatch.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Forward-declared ref the conflict handler reads to schedule an
  // auto-reload. Filled in after reloadFromServer is defined further
  // down. Direct closure capture isn't possible because performSave
  // (which dispatches the conflict branch) is declared before
  // reloadFromServer.
  const reloadFromServerRef = useRef<(() => Promise<void>) | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // Phase 2/3 sync (2026-06-05): BroadcastChannel wiring so the editor
  // notifies same-browser production-doc tabs of saves and gets
  // notified back. Without this, edits in the editor only reach
  // production-doc on the latter's 3s poll tick. The tab id is per-
  // mount-lifetime and lets the sender ignore its own echo via
  // `decideBroadcastAction`.
  const tabIdRef = useRef<string>('');
  if (tabIdRef.current === '') {
    tabIdRef.current = newTabId();
  }
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const apply = useCallback((cmd: EditorCommand) => {
    console.info('[editor store] command', { type: cmd.type });
    // Capture the pre-dispatch state so the callback can peek at the
    // undo/redo stacks (UNDO consumes the top of undoStack, REDO
    // consumes the top of redoStack — neither is visible post-dispatch).
    const prevState = stateRef.current;
    let resolvedInner: EditorCommand | null = null;
    if (cmd.type === 'UNDO') {
      resolvedInner = prevState.undoStack[prevState.undoStack.length - 1] ?? null;
    } else if (cmd.type === 'REDO') {
      resolvedInner = prevState.redoStack[prevState.redoStack.length - 1] ?? null;
    }
    dispatch(cmd);
    onAfterCommandRef.current?.({ cmd, resolvedInner, prevState });
  }, []);

  /**
   * Actually issue the PATCH. Used by the debounce timer + by the
   * manual flush path. Returns the SaveResult so callers can chain
   * UI behavior on conflict (e.g. show a toast immediately rather
   * than wait for the saveStatus state to settle).
   */
  const performSave = useCallback(async (): Promise<SaveResult | null> => {
    const current = stateRef.current;
    if (!current.isDirty) return null;

    // Abort any in-flight save so two debounces don't pile up.
    if (inFlightAbortRef.current) {
      inFlightAbortRef.current.abort();
    }
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    const versionAtAttempt = current.version;
    setSaveStatus({ kind: 'saving' });

    // Observability for data-loss diagnosis (2026-05-23): when the user
    // reports "I inserted N scenes and they disappeared", the first
    // question is "did the save include them?". Logging row count +
    // version here means console history alone can answer it without
    // adding server-side tooling.
    console.info('[editor store] save dispatch', {
      projectId,
      versionAtAttempt,
      rowCount: current.doc.rows.length,
      isDirty: current.isDirty,
    });

    const result = await saveEditorPayload({
      projectId,
      version: versionAtAttempt,
      payload: persistableFromState(current),
      signal: controller.signal,
    });

    // Discard the result if a newer save attempt has superseded us.
    if (inFlightAbortRef.current !== controller) return result;
    inFlightAbortRef.current = null;

    switch (result.kind) {
      case 'saved': {
        const savedAt = Date.now();
        // Diagnostics for the inserts-vanish-on-refresh bug class.
        // Pairs with the `save dispatch` log above so a console paste
        // shows the full round-trip: what we sent, what the server
        // returned, and the row count at each step.
        console.info('[editor store] save committed', {
          projectId,
          newVersion: result.version,
          rowCountSent: stateRef.current.doc.rows.length,
        });
        // MARK_SAVED clears isDirty unconditionally. If the user
        // typed during the round-trip, those commands flipped
        // isDirty back; we re-flip it here only if the local
        // version still matches what we started the save with.
        // The simpler invariant in the store is: MARK_SAVED clears
        // the flag, and a subsequent command flips it back — which
        // is the natural reducer behavior. So we just dispatch.
        dispatch({ type: 'MARK_SAVED', version: result.version, savedAt });
        setSaveStatus({ kind: 'saved', at: savedAt });
        // Phase 2/3 sync (2026-06-05): wake same-browser tabs (e.g.,
        // an open production-doc) immediately. The receiving tab's
        // `decideBroadcastAction` will reload or auto-rebase.
        const channel = broadcastChannelRef.current;
        if (channel) {
          try {
            const msg: ProjectPatchedBroadcast = {
              type: 'patched',
              tabId: tabIdRef.current,
              version: result.version,
            };
            channel.postMessage(msg);
            console.info('[sync broadcast-tx]', {
              projectId,
              version: result.version,
              tabId: tabIdRef.current,
              source: 'editor',
            });
          } catch (err) {
            console.warn('[sync broadcast-tx failed]', {
              projectId,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }
      case 'conflict':
        setSaveStatus({ kind: 'conflict' });
        console.warn('[editor store] save conflict — server is ahead', {
          clientVersion: versionAtAttempt,
          serverVersion: result.currentVersion,
          isDirty: stateRef.current.isDirty,
        });
        // Always auto-reload from server on conflict. Without this, a
        // single conflict (often caused by a background server-side
        // write — VO regen, captions regen, row-asset POST that
        // didn't sync version, etc.) traps the user in a banner that
        // every subsequent autosave re-triggers, while nothing they
        // do persists. Reloading consumes the server's current
        // version + payload; the next save resumes normally.
        //
        // When state is dirty we lose the unsaved local changes.
        // Surface this via a toast so the user knows what happened
        // and can redo. Skipping the reload here would be worse: the
        // user would have to manually click Reload + lose the same
        // changes anyway, plus they'd have to figure out why the
        // banner won't clear. Done via setTimeout because
        // reloadFromServer is declared further down the closure.
        // Defer the auto-reload if a user gesture (drag/resize/rotate)
        // is currently in flight. Reloading mid-gesture wipes the
        // live drag state and the user perceives "drag doesn't work."
        // We poll the gesture flag and reload once it clears.
        const tryAutoReload = () => {
          if (isGestureActive()) {
            console.info('[editor store] deferring auto-reload — gesture in flight');
            setTimeout(tryAutoReload, 250);
            return;
          }
          const wasDirty = stateRef.current.isDirty;
          console.info('[editor store] auto-reloading after conflict', { wasDirty });
          void reloadFromServerRef.current?.().then(() => {
            if (wasDirty) {
              import('sonner').then(({ toast }) => {
                toast.warning(
                  'Project was edited elsewhere — reloaded from server. Any unsaved edits since the last successful save are gone.',
                  { duration: 8000 },
                );
              }).catch(() => {});
            }
          });
        };
        setTimeout(tryAutoReload, 0);
        break;
      case 'gone':
        setSaveStatus({ kind: 'error', message: 'Project was deleted.' });
        break;
      case 'error':
        if (result.message === 'aborted') {
          // Superseded by a fresher save; not really an error.
          break;
        }
        setSaveStatus({ kind: 'error', message: result.message });
        console.warn('[editor store] save error', { detail: result.message });
        break;
    }

    return result;
  }, [projectId]);

  /**
   * Cancel any pending debounce and trigger a save immediately.
   * Returns the SaveResult (or null if nothing was dirty).
   */
  const flushSave = useCallback(async (): Promise<SaveResult | null> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    return performSave();
  }, [performSave]);


  /**
   * Re-fetch the project from the server and reset local state.
   * Used by the conflict-toast "Reload" button.
   */
  const reloadFromServer = useCallback(async () => {
    try {
      const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}`);
      if (!res.ok) {
        setSaveStatus({ kind: 'error', message: `Reload failed: HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { payload?: unknown; version?: unknown };
      if (
        typeof data.payload === 'object' && data.payload !== null &&
        typeof data.version === 'number'
      ) {
        const p = data.payload as {
          doc?: unknown;
          rowImages?: unknown;
          voiceoverUrl?: unknown;
          captions?: unknown;
          rowOverlays?: unknown;
          rowVideoClips?: unknown;
          musicUrl?: unknown;
          brandKitOverride?: unknown;
          channelId?: unknown;
          voiceoverAlignment?: unknown;
          flags?: unknown;
          linkedProjectId?: unknown;
          linkedScheduleItemId?: unknown;
          visualKitOverride?: unknown;
        };
        if (p.doc && typeof p.doc === 'object') {
          dispatch({
            type: 'RESET_FROM_SERVER',
            doc: p.doc as EditorState['doc'],
            rowImages: (p.rowImages as Record<number, string>) ?? {},
            voiceoverUrl: typeof p.voiceoverUrl === 'string' ? p.voiceoverUrl : undefined,
            captions:
              p.captions && typeof p.captions === 'object'
                ? (p.captions as EditorState['captions'])
                : undefined,
            rowOverlays:
              p.rowOverlays && typeof p.rowOverlays === 'object'
                ? (p.rowOverlays as EditorState['rowOverlays'])
                : undefined,
            rowVideoClips:
              p.rowVideoClips && typeof p.rowVideoClips === 'object'
                ? (p.rowVideoClips as EditorState['rowVideoClips'])
                : undefined,
            musicUrl: typeof p.musicUrl === 'string' ? p.musicUrl : undefined,
            brandKitOverride:
              p.brandKitOverride && typeof p.brandKitOverride === 'object'
                ? (p.brandKitOverride as EditorState['brandKitOverride'])
                : undefined,
            channelId: typeof p.channelId === 'string' ? p.channelId : undefined,
            voiceoverAlignment:
              p.voiceoverAlignment && typeof p.voiceoverAlignment === 'object'
                ? (p.voiceoverAlignment as EditorState['voiceoverAlignment'])
                : undefined,
            flags:
              p.flags && typeof p.flags === 'object'
                ? (p.flags as EditorState['flags'])
                : undefined,
            linkedProjectId: typeof p.linkedProjectId === 'string' ? p.linkedProjectId : undefined,
            linkedScheduleItemId:
              typeof p.linkedScheduleItemId === 'string' ? p.linkedScheduleItemId : undefined,
            visualKitOverride:
              p.visualKitOverride && typeof p.visualKitOverride === 'object'
                ? (p.visualKitOverride as EditorState['visualKitOverride'])
                : undefined,
            version: data.version,
          });
          setSaveStatus({ kind: 'idle' });
        }
      }
    } catch (err) {
      setSaveStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectId]);

  // Debounced auto-save: every state change schedules a save 800ms
  // after the last keystroke. New commands within the window reset
  // the timer.
  useEffect(() => {
    if (!state.isDirty) return;
    setSaveStatus({ kind: 'pending' });
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void performSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [state, performSave]);

  // Cmd/Ctrl+S — force-flush on save shortcut. Listens at the window
  // so it works even when focus is in a text input inside the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const isSave =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
      if (!isSave) return;
      e.preventDefault();
      void flushSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flushSave]);

  // ─── beforeunload safety net (2026-05-22) ───────────────────────
  //
  // If the user closes the tab / navigates away while a debounced
  // save is pending OR while the page has unsaved changes, async
  // fetch() requests die when the page tears down. `fetch(..., {
  // keepalive: true })` carries the request to completion even as
  // the page unloads — the modern replacement for sendBeacon, with
  // the bonus of supporting PATCH (sendBeacon is POST-only and our
  // editor PATCH endpoint won't accept it).
  //
  // Mirrors the same protection added to `use-project.ts` for the
  // production-doc page; the editor's store is a separate save path
  // and was previously vulnerable to the same tab-close data loss.
  //
  // Caveats:
  //   - keepalive bodies cap at 64 KB per spec. Editor payloads with
  //     dozens of overlays + saliency maps can exceed; we log and
  //     skip when that happens. The in-flight debounced save (if
  //     close to landing) may still get through normally.
  //   - Fires for tab close AND navigation AND reload — the windows
  //     where the debounced save would otherwise vanish.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const current = stateRef.current;
      if (!current.isDirty) return;
      // Block the unload with a browser confirm dialog. The keepalive
      // PATCH below races the new page's GET — fast refreshes can land
      // the GET before the PATCH commits and the user perceives their
      // edits as "lost." A confirm prompt cuts off that race entirely
      // (the user either waits for save or knowingly accepts the
      // discard). The confirm text is largely ignored by modern
      // browsers — they show a generic "Changes you made may not be
      // saved" — but setting returnValue is what triggers it.
      // 2026-05-23: introduced after inserted-scenes-vanish-on-refresh
      // bug report. See `_plans/2026-05-23-editor-insert-blank-scene-between.md`.
      e.preventDefault();
      e.returnValue = '';
      const body = JSON.stringify({
        version: current.version,
        payload: persistableFromState(current),
      });
      const bytes = new Blob([body]).size;
      if (bytes > 64 * 1024) {
        console.warn('[editor store] beforeunload skipped — body too large for keepalive', {
          projectId,
          bytes,
          rowCount: current.doc.rows.length,
        });
        return;
      }
      try {
        void fetch(`/api/edit/${encodeURIComponent(projectId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
          credentials: 'same-origin',
          keepalive: true,
        });
        console.info('[editor store] beforeunload keepalive PATCH', {
          projectId,
          version: current.version,
          rowCount: current.doc.rows.length,
          bytes,
        });
      } catch (err) {
        console.warn('[editor store] beforeunload threw', {
          projectId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [projectId]);

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z — undo / redo. Window-scoped for
  // the same reason as save: focus may be in a text input the
  // editor renders inline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) {
        apply({ type: 'REDO' });
      } else {
        apply({ type: 'UNDO' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply]);

  // Keep the forward-declared reload ref in sync. The conflict
  // handler in performSave (declared before reloadFromServer) reads
  // through this to schedule an auto-reload on safe (clean) conflicts.
  reloadFromServerRef.current = reloadFromServer;

  // Phase 2/3 sync (2026-06-05): subscribe to same-browser broadcasts
  // from other tabs (e.g., production-doc) so the editor reloads when
  // another tab patches the same project. Gates on projectId so the
  // channel is keyed correctly and torn down on prop change. Decision
  // logic (self-echo, stale, malformed, dirty → defer, clean →
  // reload) lives in `decideBroadcastAction` for test coverage.
  useEffect(() => {
    if (!projectId || !projectId.trim()) return;
    if (typeof window === 'undefined') return;
    if (typeof BroadcastChannel === 'undefined') {
      console.info('[sync broadcast] editor: BroadcastChannel unavailable', { projectId });
      return;
    }
    const channel = new BroadcastChannel(broadcastChannelName(projectId));
    broadcastChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const decision = decideBroadcastAction(
        event.data,
        tabIdRef.current,
        stateRef.current.version,
        stateRef.current.isDirty,
      );
      if (decision.kind === 'ignore') {
        console.debug('[sync broadcast-rx]', {
          projectId,
          source: 'editor',
          action: 'ignore',
          reason: decision.reason,
        });
        return;
      }
      const data = event.data as Record<string, unknown>;
      const remoteVersion = typeof data.version === 'number' ? data.version : null;
      if (decision.kind === 'conflict') {
        // Editor's own conflict handler already auto-reloads on PATCH
        // 409 with a warning toast. Same posture here: log + defer
        // to that path on the next save. We don't proactively reload
        // a dirty editor — the user is mid-gesture and a reload would
        // wipe their work without their intent.
        console.info('[sync broadcast-rx]', {
          projectId,
          source: 'editor',
          localVersion: stateRef.current.version,
          remoteVersion,
          isDirty: true,
          action: 'defer-to-save',
        });
        return;
      }
      // QA fix (2026-06-05): guard against the in-flight save window.
      // `isDirty === false` is necessary but not sufficient — there's
      // a window between `performSave` dispatch and the MARK_SAVED
      // commit where isDirty is false BUT a PATCH is still in flight.
      // Reloading in that window would discard the save's effects
      // (server has them but local state would jump back to the
      // pre-save snapshot). Defer the reload — the next broadcast or
      // poll-style tick after the save lands will pick it up.
      if (inFlightAbortRef.current !== null) {
        console.info('[sync broadcast-rx]', {
          projectId,
          source: 'editor',
          localVersion: stateRef.current.version,
          remoteVersion,
          isDirty: false,
          action: 'defer-to-save-in-flight',
        });
        return;
      }
      console.info('[sync broadcast-rx]', {
        projectId,
        source: 'editor',
        localVersion: stateRef.current.version,
        remoteVersion,
        isDirty: false,
        action: 'reload',
      });
      void reloadFromServerRef.current?.();
    };
    return () => {
      channel.close();
      if (broadcastChannelRef.current === channel) {
        broadcastChannelRef.current = null;
      }
    };
  }, [projectId]);

  return {
    state,
    apply,
    flushSave,
    reloadFromServer,
    saveStatus,
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
  };
}
