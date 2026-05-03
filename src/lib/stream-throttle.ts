// Throttles a state-applying callback during streaming reads so that long
// AI-generated payloads don't cause one React re-render per network chunk.
// Without this, a 5,000-word script delivered in hundreds of chunks
// reconciles a textarea bound to a growing string hundreds of times and
// pegs the main thread (and on slower machines, exhausts the V8 heap).
//
// Usage:
//   const t = createStreamThrottle((text: string) => {
//     setScript(text);
//     scriptRef.current?.scrollTo({ top: scriptRef.current.scrollHeight });
//   });
//   try {
//     while (true) {
//       const { done, value } = await reader.read();
//       if (done) break;
//       full += decoder.decode(value, { stream: true });
//       t.push(full);
//     }
//   } finally {
//     t.flush(); // ALWAYS flush — guarantees the final value reaches state
//   }

export interface StreamThrottle<T> {
  /** Schedule `value` for application; coalesces with later pushes within the window. */
  push: (value: T) => void;
  /** Apply the most recent pending value immediately. Safe to call multiple times. */
  flush: () => void;
  /** Drop any pending value without applying. Use when aborting and the partial state is discarded anyway. */
  cancel: () => void;
}

export function createStreamThrottle<T>(
  apply: (value: T) => void,
  intervalMs = 120,
): StreamThrottle<T> {
  let pending: T;
  let hasPending = false;
  let lastApplyAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (!hasPending) return;
    const value = pending;
    hasPending = false;
    lastApplyAt = now();
    apply(value);
  };

  const push = (value: T) => {
    pending = value;
    hasPending = true;
    const elapsed = now() - lastApplyAt;
    if (elapsed >= intervalMs) {
      flush();
    } else if (timer === null) {
      timer = setTimeout(flush, intervalMs - elapsed);
    }
  };

  const cancel = () => {
    clearTimer();
    hasPending = false;
  };

  return { push, flush, cancel };
}

// `performance.now()` exists in browsers and modern Node, but guard so the
// helper is safe to import from server-rendered modules (where it's never
// actually invoked, but the module load shouldn't crash).
function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
