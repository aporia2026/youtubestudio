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
import {
  broadcastChannelName,
  decideBroadcastAction,
  newTabId,
  type ProjectPatchedBroadcast,
} from './broadcast-sync';
import { rebasePayload } from './rebase-payload';

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

/** Phase 3 sync (2026-06-05): 800 ms → 250 ms.
 *  Same-browser tabs sync via `BroadcastChannel` in <50 ms; the
 *  network round-trip cost is the only thing the debounce protects
 *  against. 250 ms strikes the balance — still feels instantaneous
 *  to a user typing a sentence, but reduces the cross-tab lag the
 *  old 800 ms window introduced. The PATCH endpoint is sub-200 ms
 *  in p95 and the body stays small, so the increased call volume is
 *  well within the Fluid Compute envelope. */
const AUTO_SAVE_DEBOUNCE_MS = 250;

/** Phase 3 sync (2026-06-05): 8 s → 3 s.
 *  The BroadcastChannel sync covers same-browser two-tab. Polling
 *  exists as the fallback for (a) same-user two-browser / two-device,
 *  and (b) background pipeline writes (auto-pipeline running while
 *  the user has the page open). 3 s is the highest cadence we can run
 *  at without burning the prompt cache for nothing — the ping body
 *  is ~50 bytes, paused while the tab is hidden, and the slim
 *  endpoint reads `current_value(version)` from the row's JSONB. */
const POLL_INTERVAL_MS = 3_000;

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
   *  Used to be tied to a "Reload or continue" banner; Phase 3 sync
   *  flipped the default UX to silent auto-rebase + a toast (see
   *  `onAutoRebase`). The callback fires only on the rare path where
   *  auto-rebase itself fails (network error during the conflict
   *  recovery fetch). */
  onConflict?: (currentVersion: number, currentPayload: ProjectPayload) => void;
  /** Phase 3 sync (2026-06-05): called after the hook has loaded the
   *  remote payload at `newVersion` and re-applied the local edits
   *  for `preservedFields` on top of it. The consumer should show a
   *  3-second toast so the user knows a merge happened. The hook
   *  marks the rebased payload dirty so the next debounce cycle
   *  PATCHes it back up. */
  onAutoRebase?: (newVersion: number, preservedFields: string[]) => void;
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

  // Phase 2 sync (2026-06-05): same-browser instant sync via
  // BroadcastChannel. The save path posts a `patched` message after
  // every successful PATCH; a dedicated effect below subscribes and
  // routes incoming messages through `decideBroadcastAction`. The tab
  // id is per-tab-lifetime and lets the sender ignore its own echo.
  const tabIdRef = useRef<string>('');
  if (tabIdRef.current === '') {
    tabIdRef.current = newTabId();
  }
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  // Phase 3 sync (2026-06-05): top-level `ProjectPayload` field names
  // the user has touched since the last successful save. Drives
  // `rebasePayload` on conflict: only these fields are preserved from
  // local state; everything else takes the remote value. Cleared by
  // `performSave` on HTTP 200 and on `reload`.
  const dirtyFieldsRef = useRef<Set<string>>(new Set());

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
        console.info('[doc-sync poll] aborted apply — became dirty during fetch, deferring to auto-rebase', {
          projectId,
          remoteVersion: body.version,
        });
        // Phase 3 sync (2026-06-05): instead of stranding the user
        // with a conflict status, kick off the auto-rebase which
        // re-fetches and merges. The re-fetch is wasteful here but
        // this branch is narrow (typed during a poll fetch) so the
        // cost is negligible and the UX consistency wins.
        void doAutoRebaseRef.current?.();
        return;
      }
      console.info('[project payload load] client received', {
        projectId,
        version: body.version,
      });
      setPayload(body.payload as unknown as ProjectPayload);
      setVersion(body.version);
      setIsDirty(false);
      // Phase 3 sync: doLoad replaces the in-memory payload with the
      // server's truth, so any pending "dirty field" tracking would
      // describe state that no longer exists. Clear it to match.
      dirtyFieldsRef.current.clear();
      setSaveStatus({ kind: 'idle' });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [endpoint, projectId]);

  // ─── Auto-rebase (Phase 3) ──────────────────────────────────────
  //
  // The "conflict" path under Decision C of
  // `_plans/2026-06-05-strengthen-doc-editor-sync.md`: when we detect
  // the server's version is ahead of ours AND we have unsaved local
  // edits, fetch the remote payload, re-apply the local edits for the
  // fields we tracked as dirty, and signal the consumer to show a
  // 3-second toast. The rebased payload is marked dirty so the next
  // debounce cycle PATCHes it back up — no manual user action needed.
  //
  // Replaces the "Reload or continue" banner. The consumer can still
  // listen for the rare unrecoverable conflict via `onConflict` /
  // `saveStatus: 'error'` when the rebase fetch itself fails.
  const doAutoRebase = useCallback(async (): Promise<void> => {
    if (!projectId || !projectId.trim()) return;
    // Cancel any in-flight save — its result would race with our
    // freshly-loaded baseline.
    if (inFlightAbortRef.current) {
      inFlightAbortRef.current.abort();
      inFlightAbortRef.current = null;
    }
    try {
      const res = await fetch(endpoint(projectId), {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn('[sync auto-rebase] fetch failed', {
          projectId,
          status: res.status,
          detail: text,
        });
        setSaveStatus({ kind: 'error', message: 'Auto-rebase fetch failed' });
        return;
      }
      const body = (await res.json()) as LoadResponse;
      if (!isPlainObject(body.payload) || typeof body.version !== 'number') {
        console.warn('[sync auto-rebase] bad payload shape', { projectId });
        setSaveStatus({ kind: 'error', message: 'Auto-rebase: server returned unexpected shape' });
        return;
      }
      const remote = body.payload as unknown as ProjectPayload;
      const local = payloadRef.current;
      // QA fix (2026-06-05): defensive freshness check. If a save
      // landed during our GET (e.g., the broadcast that triggered
      // this rebase arrived in the same window as our own save's
      // response), the local version may now be at or past the
      // remote version we just fetched. Applying the older payload
      // would silently downgrade the page's view of the server. The
      // next poll/broadcast catches it back up, but bail here to skip
      // the wasted setState + the misleading rebase toast.
      const localVersionNow = versionRef.current;
      if (localVersionNow !== null && body.version < localVersionNow) {
        console.info('[sync auto-rebase] skip — local advanced past remote during fetch', {
          projectId,
          localVersionNow,
          remoteVersion: body.version,
        });
        return;
      }
      const preservedFields = Array.from(dirtyFieldsRef.current);
      const rebased = rebasePayload(remote, local, preservedFields);
      setPayload(rebased);
      setVersion(body.version);
      // Stay dirty until the rebased payload lands on the server —
      // the debounce timer below re-arms the save.
      setIsDirty(preservedFields.length > 0);
      setSaveStatus({ kind: preservedFields.length > 0 ? 'pending' : 'idle' });
      console.info('[sync auto-rebase]', {
        projectId,
        newVersion: body.version,
        preservedFields,
      });
      onAutoRebaseRef.current?.(body.version, preservedFields);
      // Re-arm the debounce so the rebased payload PATCHes back up.
      // performSave is captured by ref to dodge the use-before-define
      // ordering on the useCallback declarations.
      if (preservedFields.length > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          void performSaveRef.current?.();
        }, AUTO_SAVE_DEBOUNCE_MS);
      }
    } catch (err) {
      console.warn('[sync auto-rebase] threw', {
        projectId,
        detail: err instanceof Error ? err.message : String(err),
      });
      setSaveStatus({ kind: 'error', message: 'Auto-rebase failed' });
    }
  }, [endpoint, projectId]);
  const performSaveRef = useRef<(() => Promise<FlushResult>) | null>(null);
  const doAutoRebaseRef = useRef<(() => Promise<void>) | null>(null);
  doAutoRebaseRef.current = doAutoRebase;

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
      // Phase 3 sync (2026-06-05): track which top-level fields this
      // patch touched so the auto-rebase merge knows which fields the
      // user owns vs which can be safely taken from the remote.
      for (const k of Object.keys(delta)) {
        if (k !== 'version') dirtyFieldsRef.current.add(k);
      }
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
        const cleanAfterSave = versionRef.current === currentVersion;
        setIsDirty((prev) => (prev ? !cleanAfterSave : false));
        // Phase 3 sync (2026-06-05): once we know the save succeeded,
        // the local fields we sent are no longer dirty. If the user
        // typed mid-save, those new keystrokes are already in the
        // tracking set (added by `patch` during the in-flight save)
        // and stay in the set so the next debounce knows what to
        // preserve under a potential rebase.
        if (cleanAfterSave) {
          dirtyFieldsRef.current.clear();
        }
        const at = Date.now();
        setSaveStatus({ kind: 'saved', at });
        console.info('[project payload save] client committed', {
          projectId,
          newVersion: body.version,
        });
        // Phase 2 sync (2026-06-05): wake same-browser tabs immediately
        // instead of waiting for the 8s poll. `tabId` lets the receiver
        // skip its own echo via `decideBroadcastAction`. Wrapped in
        // try/catch — postMessage can throw if the channel is closed
        // mid-flight (tab teardown).
        const channel = broadcastChannelRef.current;
        if (channel) {
          try {
            const msg: ProjectPatchedBroadcast = {
              type: 'patched',
              tabId: tabIdRef.current,
              version: body.version,
            };
            channel.postMessage(msg);
            console.info('[sync broadcast-tx]', {
              projectId,
              version: body.version,
              tabId: tabIdRef.current,
            });
          } catch (err) {
            console.warn('[sync broadcast-tx failed]', {
              projectId,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { kind: 'saved', newVersion: body.version };
      }

      if (res.status === 409) {
        const body = (await res.json()) as ConflictResponse;
        console.warn('[project payload save] client conflict', {
          projectId,
          clientVersion: currentVersion,
          serverVersion: body.currentVersion,
        });
        // Phase 3 sync (2026-06-05): auto-rebase instead of flipping a
        // conflict banner. The current LWW server rarely returns 409
        // anymore — this path is kept for defense-in-depth in case a
        // future server tightens to versioned writes again. The
        // rebase replays the user's edits on top of the remote
        // payload and re-arms the save.
        void doAutoRebaseRef.current?.();
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
  // Phase 3 sync: keep a ref to performSave so the doAutoRebase
  // closure (declared earlier) can re-arm the debounce without a
  // use-before-define on the useCallback ordering.
  performSaveRef.current = performSave;

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
  const onAutoRebaseRef = useRef(options.onAutoRebase);
  onAutoRebaseRef.current = options.onAutoRebase;

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
            action: 'auto-rebase',
          });
          // Phase 3 sync (2026-06-05): replaced the banner with the
          // silent auto-rebase + toast path per Decision C. doAutoRebase
          // fetches the remote payload, re-applies the user's dirty
          // fields on top, and signals the consumer to toast.
          void doAutoRebaseRef.current?.();
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

  // ─── Same-browser instant sync via BroadcastChannel (Phase 2) ──────
  //
  // Subscribes to `broadcastChannelName(projectId)` for the lifetime
  // of the hook. When another tab in the same browser successfully
  // PATCHes the same project, this tab pulls the fresh payload within
  // a microtask instead of waiting for the 8s poll. The decision logic
  // (self-echo, stale, malformed, dirty → conflict, clean → reload)
  // lives in `decideBroadcastAction` so it can be unit-tested.
  //
  // No-op when `BroadcastChannel` is unavailable (SSR, older browsers)
  // — the poll loop still provides eventual consistency at 8s.
  //
  // Security: BroadcastChannel is same-origin only; messages from
  // other origins never reach this handler. We still defensively
  // validate every incoming message via `decideBroadcastAction`.
  useEffect(() => {
    if (!projectId || !projectId.trim()) return;
    if (typeof window === 'undefined') return;
    if (typeof BroadcastChannel === 'undefined') {
      console.info('[sync broadcast] BroadcastChannel unavailable, falling back to 8s poll', {
        projectId,
      });
      return;
    }
    const channel = new BroadcastChannel(broadcastChannelName(projectId));
    broadcastChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const decision = decideBroadcastAction(
        event.data,
        tabIdRef.current,
        versionRef.current,
        isDirtyRef.current,
      );
      if (decision.kind === 'ignore') {
        // Self-echos are by far the most common case; log at debug
        // level via console.debug so a busy console isn't flooded
        // but the trail is still grep-able when needed.
        console.debug('[sync broadcast-rx]', {
          projectId,
          action: 'ignore',
          reason: decision.reason,
        });
        return;
      }
      const data = event.data as Record<string, unknown>;
      const remoteVersion = typeof data.version === 'number' ? data.version : null;
      if (decision.kind === 'conflict') {
        console.info('[sync broadcast-rx]', {
          projectId,
          localVersion: versionRef.current,
          remoteVersion,
          isDirty: true,
          action: 'auto-rebase',
        });
        // Phase 3 sync (2026-06-05): replaced the banner path with
        // the silent auto-rebase + toast under Decision C. Same as
        // the poll-driven dirty branch above.
        void doAutoRebaseRef.current?.();
        return;
      }
      // decision.kind === 'reload'
      console.info('[sync broadcast-rx]', {
        projectId,
        localVersion: versionRef.current,
        remoteVersion,
        isDirty: false,
        action: 'reload',
      });
      // abortIfDirty=true matches the poll's race guard — covers the
      // narrow window where the user starts typing between the message
      // landing and the fetch resolving.
      void doLoadRef.current({ abortIfDirty: true });
    };
    return () => {
      channel.close();
      if (broadcastChannelRef.current === channel) {
        broadcastChannelRef.current = null;
      }
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
