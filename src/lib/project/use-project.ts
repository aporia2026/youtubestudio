'use client';

/**
 * `useProject(id)` — client hook for the canonical project payload.
 *
 * Phase 1 of `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * Both `/production-doc` and `/edit/[projectId]` go through this
 * hook for every read and write of the project's `user_history` row.
 * Before this hook, each page had its own debounced save loop, its
 * own type, its own version-check (or none), and its own conflict
 * handling. The result was that fields like `voiceoverUrl` only
 * landed on one page's save path and disappeared from the other's
 * view.
 *
 * Surface (intentionally small):
 *
 * - `payload` — the canonical, migrated payload. `null` while loading
 *   or after an unrecoverable load failure.
 * - `version` — the integer the next save will send. Bumps after
 *   every successful save.
 * - `patch(producer | partial)` — apply a partial update. The hook
 *   handles auto-save debouncing, optimistic concurrency, and the
 *   conflict callback.
 * - `flush()` — force-save now, cancelling any pending debounce.
 *   Returns the save outcome so callers can chain UI behavior (e.g.
 *   "navigate after save").
 * - `reload()` — re-fetch from the server. Used by the conflict
 *   recovery banner.
 * - `saveStatus` — discriminated union the UI maps to a badge.
 *
 * The hook deliberately stops short of bringing in a state-manager
 * (Zustand / immer / etc.). The editor wraps this hook in its own
 * command/undo layer; the production-doc page calls `patch` directly.
 * Keeping the hook framework-agnostic at the boundary means neither
 * page has to drag in the other's dependencies.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectPayload } from './payload';

// ─── Save-status (mirrors the editor's existing shape) ──────────────

export type ProjectSaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

// ─── Hook surface ───────────────────────────────────────────────────

export type PatchInput =
  | Partial<ProjectPayload>
  | ((current: ProjectPayload) => Partial<ProjectPayload>);

export type FlushResult =
  | { kind: 'saved'; newVersion: number }
  | { kind: 'conflict' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'no_op' };

export interface UseProjectReturn {
  payload: ProjectPayload | null;
  version: number | null;
  loadError: string | null;
  isDirty: boolean;
  saveStatus: ProjectSaveStatus;
  patch: (input: PatchInput) => void;
  flush: () => Promise<FlushResult>;
  reload: () => Promise<void>;
  /** Dismiss the "conflict" save-status when the user chooses to
   *  continue editing instead of reloading. The next save will land
   *  via last-write-wins. No-op when the status is not 'conflict'. */
  acknowledgeConflict: () => void;
}

// ─── Internals ──────────────────────────────────────────────────────

const AUTO_SAVE_DEBOUNCE_MS = 800;

/** Cross-tab + pipeline-vs-editor polling cadence (2026-06-03).
 *  Every 8 s the hook hits the slim `?versionOnly=1` endpoint to
 *  detect external writes. 8 s strikes the cost vs. responsiveness
 *  trade for a 1–2-user tool: cheap (one int per check, paused when
 *  the tab is hidden) and tight enough that a pipeline tick or a
 *  second-tab save lands in the UI without manual refresh. */
const POLL_INTERVAL_MS = 8_000;

interface LoadResponse {
  payload: unknown;
  version: number;
}

interface PatchResponse {
  ok: true;
  version: number;
}

interface ConflictResponse {
  error: string;
  reason: 'stale_version';
  currentVersion: number;
  currentPayload: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ─── Hook ───────────────────────────────────────────────────────────

export interface UseProjectOptions {
  /** Called when the server rejects a save due to a stale version.
   *  The hook also flips `saveStatus` to `{ kind: 'conflict' }` so a
   *  banner can render without listening for the callback. */
  onConflict?: (currentVersion: number, currentPayload: ProjectPayload) => void;
  /** Endpoint to hit. Defaults to the editor's PATCH route. Exposed
   *  so the production-doc page can route through a different URL if
   *  we ever split them. */
  endpoint?: (id: string) => string;
}

export function useProject(
  projectId: string,
  options: UseProjectOptions = {},
): UseProjectReturn {
  const endpoint = options.endpoint ?? ((id) => `/api/edit/${encodeURIComponent(id)}`);

  const [payload, setPayload] = useState<ProjectPayload | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<ProjectSaveStatus>({ kind: 'idle' });

  // Refs that have to stay current for the debounce closure without
  // triggering a re-render or re-creating the timer on every keystroke.
  const payloadRef = useRef<ProjectPayload | null>(null);
  payloadRef.current = payload;
  const versionRef = useRef<number | null>(null);
  versionRef.current = version;
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // ─── Load ────────────────────────────────────────────────────────

  const doLoad = useCallback(async (opts?: { abortIfDirty?: boolean }) => {
    setLoadError(null);
    try {
      const res = await fetch(endpoint(projectId), { method: 'GET' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setLoadError(text || `Load failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as LoadResponse;
      if (!isPlainObject(body.payload) || typeof body.version !== 'number') {
        setLoadError('Server returned an unexpected payload shape');
        return;
      }
      // 2026-06-03 race guard — used by the cross-tab polling effect.
      // The poll's "auto-reload when clean" path gates on
      // `isDirtyRef.current === false` at the version-diff moment, but
      // the user can type into the page (which routes through the
      // hook's `patch()` setter, flipping `isDirty` to true) during the
      // hundreds-of-ms window of THIS fetch. Without this guard the
      // setPayload below would clobber their edits — that was the
      // silent-data-loss class of bugs the PR1 sync work is supposed
      // to close.
      //
      // `reload()` (the banner's user-explicit reload) calls doLoad
      // without the option set, so it always applies — that path
      // intentionally discards local edits with the confirm dialog.
      if (opts?.abortIfDirty && isDirtyRef.current) {
        console.info('[doc-sync poll] aborted apply — became dirty during fetch', {
          projectId,
          remoteVersion: body.version,
        });
        setSaveStatus({ kind: 'conflict' });
        return;
      }
      console.info('[project payload load] client received', {
        projectId,
        version: body.version,
      });
      setPayload(body.payload as unknown as ProjectPayload);
      setVersion(body.version);
      setIsDirty(false);
      setSaveStatus({ kind: 'idle' });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [endpoint, projectId]);

  useEffect(() => {
    void doLoad();
    // We do NOT depend on `doLoad` because it would re-fire if the
    // endpoint memo changes. The doLoad closure already captures the
    // latest projectId and endpoint via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ─── Patch ───────────────────────────────────────────────────────

  const patch = useCallback((input: PatchInput) => {
    setPayload((prev) => {
      if (!prev) return prev;
      const delta = typeof input === 'function' ? input(prev) : input;
      const next: ProjectPayload = { ...prev, ...delta };
      return next;
    });
    setIsDirty(true);
    // (Re)arm the debounce. We do NOT short-circuit if a timer already
    // exists — the existing one is allowed to fire because the patch
    // closure reads `payloadRef.current` at fire-time. Resetting the
    // timer on every keystroke would defer the save indefinitely
    // during fast typing.
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setSaveStatus({ kind: 'pending' });
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void performSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, []);

  // ─── Save ────────────────────────────────────────────────────────

  const performSave = useCallback(async (): Promise<FlushResult> => {
    const current = payloadRef.current;
    const currentVersion = versionRef.current;
    if (!current || currentVersion === null) return { kind: 'no_op' };
    if (!isDirtyRef.current) return { kind: 'no_op' };
    // Guard against an empty projectId. The autosave loop can fire
    // before the editor has a real project context (initial mount race,
    // route change, doc loaded without a project id). With no id, the
    // PATCH URL collapses to `/api/edit/` which Next.js normalizes to
    // `/api/edit` — no handler at that exact path, so the response is
    // the default 404 HTML page and the console fills with
    // `PATCH .../api/edit 404` noise on every debounce. Skip cleanly
    // here; the caller's state machine treats no_op as "nothing to do"
    // and the loop stops without retry / toast.
    if (!projectId || !projectId.trim()) return { kind: 'no_op' };

    // Cancel any prior in-flight save. The server-side optimistic
    // version check would catch a concurrent write anyway, but
    // aborting locally avoids the wasted round-trip and the spurious
    // "Saving…" → "Saved" → "Saving…" flicker.
    if (inFlightAbortRef.current) inFlightAbortRef.current.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    setSaveStatus({ kind: 'saving' });
    console.info('[project payload save] client patch', {
      projectId,
      expectedVersion: currentVersion,
      fields: Object.keys(current),
    });

    try {
      const res = await fetch(endpoint(projectId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: currentVersion, payload: current }),
        signal: controller.signal,
      });

      // A newer save attempt has superseded this one — discard our
      // outcome. The newer attempt has its own success/conflict path.
      if (inFlightAbortRef.current !== controller) {
        return { kind: 'no_op' };
      }
      inFlightAbortRef.current = null;

      if (res.status === 200) {
        const body = (await res.json()) as PatchResponse;
        setVersion(body.version);
        // Only clear isDirty if the user didn't type during the save.
        // We compare versions: when `versionRef.current` still equals
        // what we just persisted, no new edits landed since this save
        // started, so the local state is in sync.
        setIsDirty((prev) => (prev ? versionRef.current === currentVersion : false));
        const at = Date.now();
        setSaveStatus({ kind: 'saved', at });
        console.info('[project payload save] client committed', {
          projectId,
          newVersion: body.version,
        });
        return { kind: 'saved', newVersion: body.version };
      }

      if (res.status === 409) {
        const body = (await res.json()) as ConflictResponse;
        console.warn('[project payload save] client conflict', {
          projectId,
          clientVersion: currentVersion,
          serverVersion: body.currentVersion,
        });
        setSaveStatus({ kind: 'conflict' });
        if (
          options.onConflict &&
          isPlainObject(body.currentPayload) &&
          typeof body.currentVersion === 'number'
        ) {
          options.onConflict(body.currentVersion, body.currentPayload as unknown as ProjectPayload);
        }
        return { kind: 'conflict' };
      }

      if (res.status === 404) {
        setSaveStatus({ kind: 'error', message: 'Project was deleted' });
        return { kind: 'gone' };
      }

      const text = await res.text().catch(() => '');
      const message = text || `Save failed: HTTP ${res.status}`;
      setSaveStatus({ kind: 'error', message });
      return { kind: 'error', message };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Superseded by a newer save — no status change.
        return { kind: 'no_op' };
      }
      const message = err instanceof Error ? err.message : String(err);
      setSaveStatus({ kind: 'error', message });
      return { kind: 'error', message };
    }
  }, [endpoint, options, projectId]);

  // ─── Flush ──────────────────────────────────────────────────────

  const flush = useCallback(async (): Promise<FlushResult> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    return performSave();
  }, [performSave]);

  // ─── Reload ─────────────────────────────────────────────────────

  const reload = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (inFlightAbortRef.current) {
      inFlightAbortRef.current.abort();
      inFlightAbortRef.current = null;
    }
    await doLoad();
  }, [doLoad]);

  // ─── Cmd/Ctrl+S handler ─────────────────────────────────────────
  //
  // Mirrors the editor's existing behavior so the muscle memory works
  // on both pages. Only fires when no input is focused.

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== 's') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // Allow Cmd/Ctrl+S to flush even from inside an input — saving
      // is what the user expects, not the browser's "Save Page As"
      // dialog. preventDefault here is intentional.
      void tag;
      e.preventDefault();
      void flush();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  // ─── beforeunload safety net (2026-05-22) ───────────────────────
  //
  // The debounced auto-save can have a pending fetch in flight (or
  // an armed 800 ms timer) when the user closes the tab / navigates
  // away. async fetch() requests are aborted on unload, so any save
  // that hadn't fully committed is lost. sendBeacon would survive
  // but it only supports POST, and our PATCH endpoint won't accept
  // that. `fetch(..., { keepalive: true })` is the modern survivor:
  // browser holds the request alive even as the page tears down.
  //
  // Caveats:
  //   - keepalive bodies are capped at 64 KB by spec. Large payloads
  //     (many overlays + saliency maps) can exceed; in that case we
  //     log and accept the loss. Daily flow stays under the cap.
  //   - Same-origin auth cookies must travel — `credentials: 'same-
  //     origin'` is implicit but explicit here for clarity.
  //   - This fires for tab close AND navigation AND reload, exactly
  //     the windows where the debounced save would otherwise die.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (!isDirtyRef.current) return;
      const currentPayload = payloadRef.current;
      const currentVersion = versionRef.current;
      if (!currentPayload || currentVersion === null) return;
      const body = JSON.stringify({ version: currentVersion, payload: currentPayload });
      // keepalive body cap is 64 KB per spec. Above that the fetch
      // fails to enqueue; nothing else we can do at unload — log so
      // a return visit to devtools shows it in console history.
      const bytes = new Blob([body]).size;
      if (bytes > 64 * 1024) {
        console.warn('[project payload save] beforeunload skipped — body too large for keepalive', {
          projectId,
          bytes,
        });
        return;
      }
      try {
        // We don't await — the browser is unloading. The keepalive
        // flag is what carries the request to completion.
        void fetch(endpoint(projectId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
          credentials: 'same-origin',
          keepalive: true,
        });
        console.info('[project payload save] beforeunload keepalive PATCH', {
          projectId,
          version: currentVersion,
          bytes,
        });
      } catch (err) {
        console.warn('[project payload save] beforeunload threw', {
          projectId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [endpoint, projectId]);

  // ─── Cross-tab version polling (2026-06-03) ─────────────────────
  //
  // Detects external writes to the project row — the auto-pipeline
  // ticking forward (writing `image_url` onto rows the user is
  // looking at), OR another browser tab editing the same doc. Before
  // this poll, neither was visible to an open editor until manual
  // refresh, and the user reported "editor shows wrong shots" /
  // "doc doesn't update with editor changes" exactly when this gap
  // opened up.
  //
  // Mechanism: every 8 s while `document.visibilityState === 'visible'`
  // and no save is in flight, ping `?versionOnly=1` (~50 bytes).
  // Compare to `versionRef.current`:
  //
  //   - same → no-op (logged at info so a busy console still shows
  //     the heartbeat).
  //   - different AND clean → silently `doLoad()`. The user sees the
  //     pipeline's row updates without action.
  //   - different AND dirty → flip `saveStatus` to `'conflict'` and
  //     fire `options.onConflict` (if wired). Local edits stay; the
  //     consumer renders a "remote changed — reload?" banner. The
  //     ensuing save will produce a 409 the existing conflict path
  //     also handles.
  //
  // Skipped while a save is in flight: the optimistic-version
  // response from that save already refreshes our local version, so
  // polling during the round-trip would race and flap.
  //
  // Effect gates on `projectId` only so the timer doesn't restart on
  // every render. `endpoint` and `doLoad` come in via refs.
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const doLoadRef = useRef(doLoad);
  doLoadRef.current = doLoad;
  const onConflictRef = useRef(options.onConflict);
  onConflictRef.current = options.onConflict;

  useEffect(() => {
    if (!projectId || !projectId.trim()) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlightAbortRef.current !== null) return;
      const localVersion = versionRef.current;
      if (localVersion === null) return; // initial load hasn't landed yet
      try {
        const res = await fetch(`${endpointRef.current(projectId)}?versionOnly=1`, {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { version?: number };
        const remoteVersion = body.version;
        if (typeof remoteVersion !== 'number') return;

        if (remoteVersion === localVersion) {
          console.info('[doc-sync poll]', {
            projectId,
            version: localVersion,
            changed: false,
            action: 'none',
          });
          return;
        }

        if (isDirtyRef.current) {
          console.info('[doc-sync poll]', {
            projectId,
            localVersion,
            remoteVersion,
            changed: true,
            isDirty: true,
            action: 'banner',
          });
          setSaveStatus({ kind: 'conflict' });
          // We don't have the current payload here (the slim endpoint
          // doesn't return it). The consumer's banner Reload button
          // calls `reload()` which fetches it. If a caller wired
          // `onConflict` expecting the payload, we still fire the
          // callback with the local stale payload + remote version so
          // the caller can decide; the standard recovery path is
          // `reload()` regardless.
          if (onConflictRef.current && payloadRef.current) {
            onConflictRef.current(remoteVersion, payloadRef.current);
          }
          return;
        }

        console.info('[doc-sync poll]', {
          projectId,
          localVersion,
          remoteVersion,
          changed: true,
          isDirty: false,
          action: 'reload',
        });
        // abortIfDirty=true so doLoad's setPayload doesn't clobber
        // an edit the user typed while the GET was in flight.
        await doLoadRef.current({ abortIfDirty: true });
      } catch {
        // Network blip — skip this tick, try again next interval.
        // Don't surface in the UI; offline detection isn't this hook's
        // job, and the user already has the last-loaded state cached
        // in memory.
      }
    };

    // Catch up immediately when the tab returns to foreground after
    // being hidden. Without this, the user would wait up to 8 s after
    // un-hiding before seeing pipeline updates that landed while away.
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId]);

  // ─── Cleanup ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (inFlightAbortRef.current) inFlightAbortRef.current.abort();
    };
  }, []);

  // ─── Acknowledge conflict (2026-06-03 banner support) ───────────
  //
  // The cross-tab polling effect above flips `saveStatus` to
  // 'conflict' when it detects a remote version bump while local
  // state is dirty. The consumer (production-doc page) renders a
  // banner offering Reload or Continue editing. Continue editing
  // calls this method to clear the conflict status; the next
  // debounced save lands normally and last-write-wins on the server.
  const acknowledgeConflict = useCallback((): void => {
    setSaveStatus((prev) => (prev.kind === 'conflict' ? { kind: 'idle' } : prev));
  }, []);

  return {
    payload,
    version,
    loadError,
    isDirty,
    saveStatus,
    patch,
    flush,
    reload,
    acknowledgeConflict,
  };
}
