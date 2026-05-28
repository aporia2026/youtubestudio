/**
 * Client-side helper for cross-machine user UI preferences.
 *
 * Phase 3.1 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md). Replaces localStorage-
 * only storage of UI preferences (image model default, overlay
 * defaults, brand kit, editor zoom, etc.) with a server-backed
 * `user_settings` table (migration 0102) so prefs follow the user
 * across machines and survive cache clears.
 *
 * Naming note: this file is named "user-prefs" to avoid collision
 * with the pre-existing `src/lib/user-settings.ts`, which handles a
 * completely different concept (encrypted server-side account
 * settings on collaborators.encrypted_settings — active channel id,
 * broll model defaults). The DB table is named `user_settings`
 * (migration 0102) because that's what it stores logically; the
 * client helper uses "prefs" everywhere to keep the two layers
 * cleanly separated in code.
 *
 * Design contract:
 *
 *   - `bootstrapUserPrefs()` runs once on app mount. It fetches all
 *     prefs for the current user, writes them to localStorage under
 *     each namespaced key, and from then on `getPref(key)` is a sync
 *     localStorage read. First paint is unblocked: components read
 *     whatever is already in localStorage (likely correct from a
 *     prior session) while the bootstrap fetch resolves; the next
 *     render cycle picks up canonical server values via `storage`
 *     events.
 *
 *   - `getPref<T>(key, fallback)` is synchronous. Reads localStorage
 *     with JSON.parse; on parse failure or missing key returns
 *     `fallback`. Safe to call in render.
 *
 *   - `setPref<T>(key, value)` writes localStorage immediately
 *     (optimistic) AND queues a `mutate('user-prefs.set', ...)` call
 *     so the server gets the value. The mutate() chokepoint handles
 *     retry / dedup / breaker. Pass `null` to clear on both sides.
 *
 * What this helper does NOT do:
 *   - Conflict resolution beyond last-write-wins. Acknowledged in the
 *     migration's header; for the single-user-N-machines case we
 *     don't have a meaningful conflict to solve.
 *   - Encrypted storage for sensitive keys (API keys). Phase 3.1
 *     flagged this; encryption gated on a user decision per the
 *     plan's open question #4. Do NOT store secrets here until that
 *     ships.
 */
import { mutate } from './mutate';

const LOG_NS = '[user-prefs]';

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

interface BootstrapResponse {
  prefs?: Record<string, unknown>;
}

/**
 * One-time on app mount. Loads all prefs from /api/user-prefs and
 * writes them into localStorage so synchronous getPref() reads see
 * canonical values. Idempotent: a second call returns the same
 * in-flight promise.
 */
export function bootstrapUserPrefs(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      bootstrapped = true;
      return;
    }
    try {
      // eslint-disable-next-line no-restricted-syntax -- one-shot bootstrap read; never mutates server state, doesn't belong in the outbox.
      const res = await fetch('/api/user-prefs', {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        log('bootstrap-failed', { status: res.status });
        return;
      }
      const data = (await res.json()) as BootstrapResponse;
      const prefs = data.prefs ?? {};
      for (const [k, v] of Object.entries(prefs)) {
        try {
          localStorage.setItem(storageKey(k), JSON.stringify(v));
        } catch {
          // Quota / private mode — log + continue. Other keys may
          // still write successfully.
          log('bootstrap-set-failed', { key: k });
        }
      }
      log('bootstrap', { count: Object.keys(prefs).length });
    } catch (err) {
      log('bootstrap-threw', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      bootstrapped = true;
    }
  })();
  return bootstrapPromise;
}

/** Synchronous read. Returns `fallback` if the key is missing or
 *  the stored value can't be parsed. Safe in render. */
export function getPref<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a pref. Sets localStorage immediately and queues a server
 *  PUT through the mutate() chokepoint. Pass `null` to clear the
 *  pref on both sides. */
export function setPref<T>(key: string, value: T | null): void {
  if (typeof localStorage !== 'undefined') {
    try {
      if (value === null) {
        localStorage.removeItem(storageKey(key));
      } else {
        localStorage.setItem(storageKey(key), JSON.stringify(value));
      }
    } catch {
      // localStorage write failed (quota, Safari Private Mode). The
      // server PUT still queues below so the value reaches the
      // server; the local read on next mount will pick it up via
      // the bootstrap.
      log('set-localstorage-failed', { key });
    }
  }
  mutate('user-prefs.set', {
    method: 'PUT',
    url: '/api/user-prefs',
    body: { key, value },
  });
  log('set', { key });
}

/** Whether bootstrap has completed. Exposed for tests + for the
 *  rare component that needs to wait before reading. */
export function isBootstrapped(): boolean {
  return bootstrapped;
}

/** Test-only — reset the bootstrap latch so a subsequent
 *  bootstrapUserPrefs() re-runs against a fresh mock. */
export function _resetUserPrefsForTests(): void {
  bootstrapped = false;
  bootstrapPromise = null;
}

// ── Internals ────────────────────────────────────────────────────────

/** Namespace localStorage keys so they don't collide with the bare
 *  keys the production-doc page uses today ('prodoc_image_model',
 *  'video_brand_kit', etc.). During the migration window both keys
 *  may exist; the migrated key takes precedence once read sites
 *  switch to getPref(). */
function storageKey(key: string): string {
  return `usersettings:${key}`;
}

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info(`${LOG_NS} ${event}`, fields);
}
