'use client';

/**
 * Custom hook that mirrors a piece of state to localStorage so the
 * /shorts/batch drafting flow survives refreshes + accidental closes.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Conventions:
 *   - Keys are namespaced by user (workspace_id + uid) so two users on
 *     the same browser never collide.
 *   - Storage is best-effort: a Safari private-mode / quota-exceeded
 *     throw degrades to in-memory state without crashing the page.
 *   - The draft is cleared explicitly via `clear()` once the batch
 *     row has been created server-side (the URL takes over from there).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_PREFIX = 'shorts-batch-draft:';

/** Build a namespaced storage key. Both arguments are required so we
 *  never silently leak a draft into another workspace's tab. */
function buildKey(workspaceId: string, userId: string): string {
  return `${STORAGE_PREFIX}${workspaceId}:${userId}`;
}

/** Persist a draft object. Returns a `[draft, setDraft, clear]` tuple
 *  shaped like useState, with a `clear()` method that wipes the
 *  storage entry (used after the batch row has been created). */
export function useBatchDraft<T>(
  workspaceId: string,
  userId: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const key = buildKey(workspaceId, userId);
  // Lazy initializer: read once on mount. SSR returns the seed so
  // hydration doesn't mismatch — the first useEffect tick rehydrates
  // from localStorage if a draft exists.
  const [draft, setDraftState] = useState<T>(initial);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        setDraftState(parsed);
      }
    } catch {
      /* corrupt blob — keep the seed */
    }
  }, [key]);

  const setDraft = useCallback(
    (next: T | ((prev: T) => T)) => {
      setDraftState((prev) => {
        const value =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
        } catch {
          /* quota / private mode — fall back to in-memory state */
        }
        return value;
      });
    },
    [key],
  );

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* noop */
    }
    setDraftState(initial);
  }, [key, initial]);

  return [draft, setDraft, clear];
}
