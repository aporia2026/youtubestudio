/**
 * Client-side throttle for production-doc image-gen calls.
 *
 * Mirrors the two server rate-limit buckets so the editor stops slamming
 * the wall during variant-retry storms and rapid-fire manual retries.
 * Plan: `_plans/2026-05-27-image-gen-client-throttle.md`.
 *
 * Two categories matching the server bucket classes:
 *
 *   - `generate` → /image, /collage (server cap 30/min on `prodoc-img`)
 *   - `edit`     → /image/edit, /image/rmbg (server caps 20/min each)
 *
 * Client caps sit one-bucket below the server cap so timing jitter
 * never forces a real 429:
 *
 *   - generate: 25 calls / 60s
 *   - edit:     18 calls / 60s
 *
 * **Collage = 1 token.** A `generate`-category call to `/collage` is
 * counted exactly like a single-shot `/image` call. The server treats
 * them as 1 token each too (same `prodoc-img:${ip}` key) so this mirror
 * is faithful. Collage's 4-images-per-call throughput is preserved
 * automatically.
 *
 * One global concurrency cap (3 in-flight, across both categories) so
 * a burst of edits doesn't crowd out a generate or vice versa.
 *
 * Server cost guard stays unchanged. This is a UX/queueing layer, not
 * a security control — page refresh resets local state, the server
 * bucket is the source of truth (rule 13).
 *
 * Consumers:
 *   - editor pages       → `queueImageGen(category, label, fn)` to
 *                          enqueue every image-gen fetch
 *   - ImageGenThrottleToast → `subscribeThrottle` for live queue state
 *
 * Observability (rule 14): `[image-gen throttle]` namespaced
 * `console.info` at every meaningful step. No external logger
 * dependency — this is browser-side code.
 */

export type ThrottleCategory = 'generate' | 'edit';

/** Public state shape consumed by the toast subscriber. Snapshot — not
 *  a live reference, so the toast can shallow-compare and re-render
 *  cheaply. */
export interface ThrottleState {
  inFlight: number;
  queued: number;
  tokensLeft: Record<ThrottleCategory, number>;
}

interface CategoryConfig {
  /** Max calls allowed in a rolling 60s window. Set one below the
   *  matching server cap so jitter never produces a real 429. */
  capPerMinute: number;
}

const CATEGORY_CONFIG: Record<ThrottleCategory, CategoryConfig> = {
  // Server cap is 30/min on `prodoc-img` (shared by /image + /collage).
  // 25 leaves 5/min headroom for the variant exponential-backoff
  // retries that previously caused the cascade.
  generate: { capPerMinute: 25 },
  // Server cap is 20/min on `prodoc-img-edit` and `prodoc-img-rmbg`.
  // 18 leaves 2/min headroom — edits are bursty (mask-brush + erase
  // happen back-to-back) so headroom matters less, but the math is
  // the same.
  edit: { capPerMinute: 18 },
};

const WINDOW_MS = 60_000;
const MAX_CONCURRENCY = 3;

/** Sliding window of acquire timestamps per category. Entries older
 *  than WINDOW_MS are pruned on each acquire. */
const recentAcquires: Record<ThrottleCategory, number[]> = {
  generate: [],
  edit: [],
};

let inFlight = 0;

interface QueuedCall {
  category: ThrottleCategory;
  label: string;
  enqueuedAt: number;
  resolve: () => void;
}
const waitQueue: QueuedCall[] = [];

const subscribers = new Set<(state: ThrottleState) => void>();

function pruneWindow(category: ThrottleCategory, now: number): void {
  const arr = recentAcquires[category];
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

function tokensLeftFor(category: ThrottleCategory, now: number): number {
  pruneWindow(category, now);
  return Math.max(0, CATEGORY_CONFIG[category].capPerMinute - recentAcquires[category].length);
}

function snapshotState(): ThrottleState {
  const now = Date.now();
  return {
    inFlight,
    queued: waitQueue.length,
    tokensLeft: {
      generate: tokensLeftFor('generate', now),
      edit: tokensLeftFor('edit', now),
    },
  };
}

function notifySubscribers(): void {
  if (subscribers.size === 0) return;
  const state = snapshotState();
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch (err) {
      console.warn('[image-gen throttle] subscriber threw', { detail: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** True when the next call of `category` could acquire immediately.
 *  Caller still has to go through the queue — this is just a check. */
function canAcquire(category: ThrottleCategory, now: number): boolean {
  if (inFlight >= MAX_CONCURRENCY) return false;
  return tokensLeftFor(category, now) > 0;
}

/** Schedule `pump` to run at the next moment a queued call could acquire.
 *  Used so we don't busy-poll while waiting for the token window to roll. */
let pumpScheduled = false;
function schedulePump(): void {
  if (pumpScheduled || waitQueue.length === 0) return;
  const now = Date.now();
  // Earliest moment ANY category's bucket could free up. Per category:
  // (oldest entry in window + WINDOW_MS) — at that instant prune removes
  // it and a token frees up. Take the min across categories that have
  // queued waiters.
  let earliest = Infinity;
  for (const w of waitQueue) {
    const arr = recentAcquires[w.category];
    if (arr.length < CATEGORY_CONFIG[w.category].capPerMinute) {
      // Bucket already has room; we're just waiting on concurrency.
      // No timer needed — the in-flight release will trigger pump.
      continue;
    }
    const oldest = arr[0];
    if (oldest != null) {
      const freesAt = oldest + WINDOW_MS;
      if (freesAt < earliest) earliest = freesAt;
    }
  }
  if (!isFinite(earliest)) return;
  const delay = Math.max(0, earliest - now) + 5; // 5ms buffer for clock skew
  pumpScheduled = true;
  setTimeout(() => {
    pumpScheduled = false;
    pump();
  }, delay);
}

/** Try to dequeue waiters in FIFO order. Stops at the first waiter
 *  whose category can't acquire (others may still be servable, but FIFO
 *  prevents starvation; the next pump cycle picks them up). */
function pump(): void {
  const now = Date.now();
  while (waitQueue.length > 0) {
    const head = waitQueue[0];
    if (!canAcquire(head.category, now)) break;
    waitQueue.shift();
    recentAcquires[head.category].push(now);
    inFlight++;
    const waitMs = now - head.enqueuedAt;
    console.info('[image-gen throttle acquired]', {
      category: head.category,
      label: head.label,
      wait_ms: waitMs,
      tokens_left: tokensLeftFor(head.category, now),
      in_flight: inFlight,
    });
    head.resolve();
  }
  notifySubscribers();
  schedulePump();
}

/** Acquire a slot. Resolves when `fn` may run. The caller MUST call
 *  the returned `release` exactly once when its work is done (success
 *  OR failure). */
async function acquire(category: ThrottleCategory, label: string): Promise<() => void> {
  const now = Date.now();
  if (canAcquire(category, now) && waitQueue.length === 0) {
    // Fast path — no queue, take the slot.
    recentAcquires[category].push(now);
    inFlight++;
    console.info('[image-gen throttle acquired]', {
      category,
      label,
      wait_ms: 0,
      tokens_left: tokensLeftFor(category, now),
      in_flight: inFlight,
    });
    notifySubscribers();
    return () => release();
  }
  // Slow path — queue and wait.
  console.info('[image-gen throttle queued]', {
    category,
    label,
    depth: waitQueue.length + 1,
    in_flight: inFlight,
    tokens_left: tokensLeftFor(category, now),
  });
  await new Promise<void>((resolve) => {
    waitQueue.push({ category, label, enqueuedAt: now, resolve });
    notifySubscribers();
    schedulePump();
  });
  return () => release();
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  pump();
}

/**
 * Run `fn` under the throttle. Resolves with `fn`'s value (or rejects
 * with its rejection — the throttle is transparent w.r.t. errors).
 * Always releases the slot, even on rejection.
 *
 * @param category — server bucket class this call hits
 * @param label    — short identifier for log lines ('variant-edit',
 *                   'bulk-collage', etc.)
 * @param fn       — the async work to throttle
 */
export async function queueImageGen<T>(
  category: ThrottleCategory,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const releaseFn = await acquire(category, label);
  const acquiredAt = Date.now();
  try {
    const result = await fn();
    return result;
  } finally {
    releaseFn();
    console.info('[image-gen throttle done]', {
      category,
      label,
      total_ms: Date.now() - start,
      throttle_ms: acquiredAt - start,
    });
  }
}

/**
 * Caller-side hook for reporting an upstream 429. When the throttle's
 * headroom isn't enough (race across tabs, server cap was tightened, a
 * different route in another browser tab burned the same bucket), the
 * caller's fetch will still see a 429. Calling this stalls the
 * category's bucket so the next acquire waits for the window to roll —
 * preventing an instant-retry tight loop.
 *
 * Implementation: push 5 phantom timestamps into the category's window
 * so the bucket reads as ~full for the next ~12s (5/25 of a minute).
 */
export function reportUpstream429(category: ThrottleCategory, label: string): void {
  const now = Date.now();
  for (let i = 0; i < 5; i++) recentAcquires[category].push(now);
  console.info('[image-gen throttle 429]', {
    category,
    label,
    backoff_phantoms: 5,
    tokens_left: tokensLeftFor(category, now),
  });
  notifySubscribers();
}

/** Public state snapshot. Pure read — does not mutate the queue. */
export function getThrottleState(): ThrottleState {
  return snapshotState();
}

/** Subscribe to throttle state changes. Returns the unsubscribe fn.
 *  Subscriber is called with a fresh snapshot on every queue mutation. */
export function subscribeThrottle(fn: (state: ThrottleState) => void): () => void {
  subscribers.add(fn);
  // Push initial state so callers don't have to mirror it.
  fn(snapshotState());
  return () => {
    subscribers.delete(fn);
  };
}

/** Test-only: reset all queue state. NOT exported via index — imported
 *  directly by the unit-test file. */
export function __resetForTests(): void {
  recentAcquires.generate.length = 0;
  recentAcquires.edit.length = 0;
  inFlight = 0;
  waitQueue.length = 0;
  pumpScheduled = false;
  subscribers.clear();
}
