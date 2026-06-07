'use client';

/**
 * Tiny localStorage-backed useState wrapper.
 *
 * Used by the channel-clone forms (and the in-job panel) so that
 * pre-submit / in-progress UI state survives a page refresh, tab
 * close, or "I clicked the wrong link" mishap.
 *
 * Why not server-side drafts: a "run" is server-persisted from the
 * moment intake fires. What gets lost on refresh is the PRE-submit
 * UI: URL paste, source label, per-video transcripts the operator
 * typed but hasn't yet sent, the topic/hook radio they picked but
 * haven't yet confirmed. None of that has a stable identity yet —
 * there's no DB row to update. localStorage is the right tool for
 * pre-DB-commit ephemeral state: zero schema, zero network, zero
 * cost, and survives every refresh / close / crash the operator
 * can throw at it.
 *
 * Cross-device sync is NOT a goal here. If an operator wants to
 * continue on another machine, they hit "Start intake" — at which
 * point the run lives on the server and is workspace-scoped.
 *
 * Contract:
 *   - SSR-safe: returns the initial value when window is undefined.
 *   - First-render hydration: reads from localStorage once on mount.
 *     Avoids the "flash of initial value" by deferring the read to a
 *     useEffect rather than running it during render.
 *   - JSON-only: pass plain objects / strings / numbers / booleans.
 *     File / Blob / etc. cannot be persisted.
 *   - Versioned keys: the caller picks the storage key. Prepend a
 *     workspace id or job id when the state is scoped to one of
 *     those, so multi-workspace operators don't see ghost state
 *     from a previous account.
 *
 * Plan-2025-06-08 — persistence of channel-clone WIP state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PersistedStateOptions {
  /** Pass `false` to skip persisting (e.g. SSR contexts or when the
   *  key is not yet known). Defaults to `true`. */
  enabled?: boolean;
}

/** Like `useState`, but mirrored to localStorage under `key`. */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  options: PersistedStateOptions = {},
): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const enabled = options.enabled ?? true;
  const [value, setValue] = useState<T>(initialValue);
  const hydratedRef = useRef<boolean>(false);

  // First-mount hydration. Skipped on SSR; runs once per key.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        setValue(JSON.parse(raw) as T);
      }
    } catch {
      // Corrupt JSON / SecurityError on private mode — fall back to
      // the supplied initial value. Not worth surfacing to the UI.
    }
    hydratedRef.current = true;
  }, [key, enabled]);

  // Persist on every change AFTER hydration. The hydrated-ref guard
  // prevents the post-hydration setValue (in the effect above) from
  // immediately writing the same value back out.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    if (!hydratedRef.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // QuotaExceeded / SecurityError — silently drop. Caller's UI
      // still behaves correctly; the operator just loses persistence.
    }
  }, [key, value, enabled]);

  const clear = useCallback(() => {
    if (!enabled || typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, [key, enabled]);

  return [value, setValue, clear];
}
