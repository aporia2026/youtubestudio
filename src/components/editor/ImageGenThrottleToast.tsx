'use client';

/**
 * Sticky bottom-right toast that surfaces the image-gen throttle state
 * to the user in real time. Mounts in `/production-doc` and
 * `/edit/[projectId]`; subscribes to the shared throttle module's pub/
 * sub and renders only when something is in flight or queued.
 *
 * Plan: `_plans/2026-05-27-image-gen-client-throttle.md`.
 *
 * The toast replaces the per-row "Failed / Retry" surface that 429s
 * used to trigger. With the throttle keeping us under the server cap,
 * the user sees calm queue progress instead of an angry red pill on
 * every row that hit a race. Per rule 16: a clear, intuitive status
 * that tells the user "X queued, Y in flight, no action needed."
 *
 * No props — fully self-driven from `subscribeThrottle`.
 *
 * Auto-dismiss: when the queue empties, the component stays mounted
 * for ~800ms then hides. Re-shows instantly when work appears again.
 */

import { useEffect, useState } from 'react';
import { subscribeThrottle, type ThrottleState } from '@/lib/image-gen-throttle';

export function ImageGenThrottleToast() {
  const [state, setState] = useState<ThrottleState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = subscribeThrottle(setState);
    return unsub;
  }, []);

  useEffect(() => {
    if (!state) return;
    const busy = state.inFlight + state.queued > 0;
    if (busy) {
      setVisible(true);
      return;
    }
    // Hide after a short delay so a rapid acquire→release doesn't
    // flicker the toast. 800ms is long enough for the user to confirm
    // a quick gen actually ran but not so long the toast lingers.
    const t = setTimeout(() => setVisible(false), 800);
    return () => clearTimeout(t);
  }, [state]);

  if (!visible || !state) return null;

  const busy = state.inFlight + state.queued > 0;
  const lowTokens =
    state.tokensLeft.generate < 5 || state.tokensLeft.edit < 3;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-neutral-800 bg-neutral-900/95 px-4 py-3 text-sm text-neutral-100 shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-2">
        {busy ? (
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400"
            aria-hidden="true"
          />
        ) : (
          <span
            className="inline-block h-2 w-2 rounded-full bg-neutral-500"
            aria-hidden="true"
          />
        )}
        <span className="font-medium">
          {busy ? 'Generating images' : 'Generations complete'}
        </span>
      </div>
      {busy && (
        <div className="mt-1 text-xs text-neutral-300">
          {state.inFlight} in flight
          {state.queued > 0 && (
            <>
              {' • '}
              <span className="text-amber-300">{state.queued} queued</span>
            </>
          )}
          {lowTokens && (
            <>
              {' • '}
              <span className="text-amber-300" title="Pacing to stay under the server rate limit">
                pacing
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
