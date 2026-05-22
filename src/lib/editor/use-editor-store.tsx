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

export function useEditorStore(initial: EditorState, projectId: string): UseEditorStoreReturn {
  const [state, dispatch] = useReducer(
    (s: EditorState, cmd: EditorCommand) => applyCommand(s, cmd),
    initial,
  );

  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

  // Refs that need to stay current for the debounce closure without
  // re-creating the timer on every dispatch.
  const stateRef = useRef(state);
  stateRef.current = state;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  const apply = useCallback((cmd: EditorCommand) => {
    console.info('[editor store] command', { type: cmd.type });
    dispatch(cmd);
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
        // MARK_SAVED clears isDirty unconditionally. If the user
        // typed during the round-trip, those commands flipped
        // isDirty back; we re-flip it here only if the local
        // version still matches what we started the save with.
        // The simpler invariant in the store is: MARK_SAVED clears
        // the flag, and a subsequent command flips it back — which
        // is the natural reducer behavior. So we just dispatch.
        dispatch({ type: 'MARK_SAVED', version: result.version, savedAt });
        setSaveStatus({ kind: 'saved', at: savedAt });
        break;
      }
      case 'conflict':
        setSaveStatus({ kind: 'conflict' });
        console.warn('[editor store] save conflict — server is ahead', {
          clientVersion: versionAtAttempt,
          serverVersion: result.currentVersion,
        });
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
    const onBeforeUnload = () => {
      const current = stateRef.current;
      if (!current.isDirty) return;
      const body = JSON.stringify({
        version: current.version,
        payload: persistableFromState(current),
      });
      const bytes = new Blob([body]).size;
      if (bytes > 64 * 1024) {
        console.warn('[editor store] beforeunload skipped — body too large for keepalive', {
          projectId,
          bytes,
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
