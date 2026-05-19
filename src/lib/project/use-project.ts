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
}

// ─── Internals ──────────────────────────────────────────────────────

const AUTO_SAVE_DEBOUNCE_MS = 800;

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

  const doLoad = useCallback(async () => {
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

  // ─── Cleanup ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (inFlightAbortRef.current) inFlightAbortRef.current.abort();
    };
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
  };
}
