'use client';

/**
 * Client-side gate for local-studio surfaces.
 *
 * The `/api/local-studio/*` routes return 404 when `LOCAL_STUDIO=1`
 * is unset (production Vercel always lacks it). Production-doc and
 * b-roll picker UIs filter out local-only model entries based on
 * whether `/api/local-studio/status` returned 200 — i.e. whether the
 * current dev/prod environment has the local stack wired up.
 *
 * Result is fetched once and cached at module scope so every picker
 * shares the answer without re-hitting the endpoint.
 */
import { useEffect, useState } from 'react';

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;
const listeners = new Set<(enabled: boolean) => void>();

async function fetchEnabled(): Promise<boolean> {
  if (cached !== null) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      // 404 → flag unset OR route disabled in production = "not enabled".
      // 200 → the dev `LOCAL_STUDIO=1` env is wired up = "enabled".
      const r = await fetch('/api/local-studio/status');
      cached = r.ok;
    } catch {
      // Network failure — treat as not enabled rather than spamming
      // the picker with broken entries.
      cached = false;
    }
    for (const l of listeners) l(cached);
    pending = null;
    return cached;
  })();
  return pending;
}

/**
 * React hook for the picker UIs. Returns `false` until the first
 * status check resolves; flips to `true` if the local stack is on.
 *
 * Renders that depend on this hook should be defensive — when
 * `false`, hide local-provider models from the option list so users
 * don't see entries that will 503 on click.
 */
export function useLocalStudioEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) {
      setEnabled(cached);
      return;
    }
    let active = true;
    const handler = (next: boolean) => {
      if (active) setEnabled(next);
    };
    listeners.add(handler);
    void fetchEnabled();
    return () => {
      active = false;
      listeners.delete(handler);
    };
  }, []);
  return enabled;
}
