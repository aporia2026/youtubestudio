/**
 * Client-side mutation chokepoint with a durable IndexedDB outbox.
 *
 * Phase 1.2 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md).
 *
 * The bug class we're closing:
 *   The production-doc page (and four other surfaces) used to persist
 *   server-meaningful state via `void fetch(...).catch(() => {})`. On
 *   any of: tab close before the promise settled, transient 5xx,
 *   network blip, missing entity id race, or 800ms debounce eviction —
 *   the write silently disappeared. Real damage: doc d244130f-bdfe
 *   had 181 rows saved but every image attach lost. Users paid for
 *   generations that never reached the server.
 *
 * The contract this module provides:
 *   `mutate(kind, options)` returns a `MutateHandle` synchronously.
 *   The mutation is persisted to IndexedDB BEFORE the call returns,
 *   so a refresh / tab close at this point loses NOTHING — the
 *   drainer will retry on next mount.
 *
 *   The drainer walks the queue in insertion order, POSTing each
 *   entry with `X-Intent-Id: <uuid>`. The server uses that header
 *   plus the `mutation_ids` table (migration 0101) to dedupe retries
 *   — a request whose intent id already landed returns the cached
 *   result (or just 200) without re-running the side effect, so
 *   networks-not-perfect retries are safe.
 *
 * What this module does NOT do (deferred per the plan):
 *   - No UI status indicator (Phase 1.4 — subscribers can hook
 *     `onChange` and render their own pill).
 *   - No circuit breaker that refuses new paid intents when the
 *     drain is broken (Phase 2.3).
 *   - No promise-based ack — every caller is fire-and-forget. The
 *     queue guarantees eventual delivery; if a caller needs to know
 *     when the server saw their write, they can poll `getState()`
 *     or subscribe to changes. This keeps the API minimal for
 *     Phase 1.2; we can layer an `ack` promise on in 1.4 if needed.
 *   - No cross-tab leader election (BroadcastChannel). Multiple tabs
 *     racing to drain the same intent will both win at the server
 *     thanks to mutation_ids dedup — wasted bandwidth but no
 *     correctness issue. Adding the leader election later is
 *     straightforward; not worth the complexity in v1.
 *
 * Failure mode the user must understand:
 *   IndexedDB CAN evict (Safari Private Mode 7-day, storage pressure
 *   in any browser, user clears site data). If that happens the queue
 *   is lost — but so is the optimistic UI state, so the user just
 *   re-runs the action. The visible UI status (Phase 1.4) will show
 *   "Saved" only after server ACK so the user is never lied to about
 *   durability.
 */
import { createStore, set, get, del, keys, type UseStore } from 'idb-keyval';

const STORE_DB = 'claude-outbox';
const STORE_NAME = 'mutations';
const LOG_NS = '[mutate]';

/** Maximum backoff between attempts (ms). At ~10 attempts at 2^N we'd
 *  exceed this; the helper caps each delay so a long failure window
 *  doesn't push the next retry off-schedule. */
const MAX_BACKOFF_MS = 60_000;
/** Initial backoff base (ms). First retry sleeps 1s, then 2s, 4s, … */
const BASE_BACKOFF_MS = 1_000;
/** Give up after this many attempts — the entry stays in IDB but is
 *  marked `dead: true` so the drainer skips it. Phase 1.4 surfaces
 *  dead entries to the user as "Couldn't save N items, retry?". */
const MAX_ATTEMPTS = 10;

// ── Circuit breaker (Phase 2.3) ──────────────────────────────────────
//
// When the drainer's recent send attempts fail at a high rate, open
// the breaker so callers can see "the network / server is down" and
// either refuse new paid actions or surface a warning to the user.
// The breaker is informational by default — it does NOT block enqueue
// in v1 (the outbox can still hold the entry safely; the breaker just
// surfaces a real signal so the user isn't lied to). UI surfaces it
// via getState().breaker.
//
// Rules:
//   - Track the last BREAKER_WINDOW outcomes (a small ring buffer).
//   - Open when failures hit BREAKER_THRESHOLD inside the window.
//   - Stay open for BREAKER_COOLDOWN_MS, then transition to half-open.
//   - Half-open: next drain attempt is the probe. On success → close
//     (clear failure history). On failure → re-open with the same
//     cooldown.
const BREAKER_WINDOW = 5;
const BREAKER_THRESHOLD = 4;             // 4/5 failures in window
const BREAKER_COOLDOWN_MS = 30_000;
type BreakerState = 'closed' | 'open' | 'half-open';

export interface MutateOptions {
  /** HTTP method. Defaults to POST. */
  method?: string;
  /** Fully-qualified URL or app-relative path. */
  url: string;
  /** JSON-serialisable body. Skip for GETs or for routes that take
   *  query strings on the URL. */
  body?: unknown;
  /** Extra request headers. `Content-Type: application/json` and
   *  `X-Intent-Id` are added by the drainer automatically. */
  headers?: Record<string, string>;
}

export interface MutateAckSuccess {
  ok: true;
  /** Parsed JSON response body. `undefined` when the server returned
   *  a non-JSON body or an empty 204. */
  data?: unknown;
  /** HTTP status of the successful response (200 / 204 / 409-as-dedup). */
  status: number;
}

export interface MutateAckFailure {
  ok: false;
  /** HTTP status when the failure was a 4xx terminal. `undefined`
   *  when the failure was a thrown fetch (network) or the entry was
   *  marked dead after MAX_ATTEMPTS retries. */
  status?: number;
  /** Human-readable reason — server error body for HTTP failures,
   *  `Error.message` for thrown fetches, `'exhausted'` for dead entries. */
  reason: string;
}

export type MutateAck = MutateAckSuccess | MutateAckFailure;

export interface MutateHandle {
  /** The intent id stored on the entry. Also sent to the server as
   *  `X-Intent-Id`. Stable across retries. */
  intentId: string;
  /** Resolves when the drainer reaches a terminal state for this
   *  entry — success (2xx / 409 dedup), terminal 4xx failure, or
   *  exhausted retries. The promise is in-memory only: an entry
   *  recovered from IDB on a fresh page load has no corresponding
   *  ack (the original tab's promise died with the tab). Callers
   *  that need to observe success after a refresh should subscribe
   *  to outbox state and re-read the affected entity. */
  ack: Promise<MutateAck>;
}

interface OutboxEntry {
  id: string;
  kind: string;
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
  attempt: number;
  /** Epoch ms — drainer skips entries with `nextAt > now`. */
  nextAt: number;
  createdAt: number;
  /** Set true after MAX_ATTEMPTS retries. Kept in the queue so the UI
   *  can surface it; explicitly NOT deleted so a future "retry all"
   *  affordance can revive them. */
  dead?: boolean;
  /** Last failure reason — surfaced in UI for dead entries. */
  lastError?: string;
}

export interface OutboxState {
  pending: number;
  failed: number;
  /** Whether the drainer is currently mid-loop. UIs use this to show
   *  a "saving…" spinner. */
  draining: boolean;
  /** Circuit-breaker state. Surfaces to the UI so callers can show a
   *  "Saving paused — retry in N seconds" warning when the breaker is
   *  open. In v1 the breaker does NOT block enqueue; it's a trust
   *  signal so the user isn't lied to about durability when the
   *  network / server is clearly down. */
  breaker: BreakerState;
  /** When the breaker is 'open', the epoch-ms timestamp at which it
   *  transitions to half-open. UIs render the countdown. Null when
   *  the breaker is closed or half-open. */
  breakerReopenAt: number | null;
}

type Subscriber = (state: OutboxState) => void;

// ── Module state (browser-only; SSR paths short-circuit) ─────────────

const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
const store: UseStore | null = isBrowser ? createStore(STORE_DB, STORE_NAME) : null;
const subscribers = new Set<Subscriber>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
let lastState: OutboxState = {
  pending: 0,
  failed: 0,
  draining: false,
  breaker: 'closed',
  breakerReopenAt: null,
};

// Breaker state (module-local, browser tab scope). The window holds
// the last N drain outcomes as booleans: true = success, false =
// failure. We push at the front and trim from the back.
let breakerState: BreakerState = 'closed';
let breakerWindow: boolean[] = [];
let breakerReopenAt: number | null = null;

// In-memory ack registry, keyed by intent id. Populated by mutate()
// at enqueue time, resolved by the drainer at terminal state. Cleared
// after resolve so the map doesn't grow unboundedly. NOT persisted
// across page loads — entries IDB-recovered from a prior session
// have no ack (the original tab's promise died with the tab).
const ackResolvers = new Map<string, (ack: MutateAck) => void>();

// ── Public API ───────────────────────────────────────────────────────

/**
 * Enqueue a server mutation. Returns synchronously with the intent id;
 * the actual POST is sent in the background by the drainer and will
 * survive refresh / tab close / network failures.
 *
 * The optimistic UI update is the caller's responsibility — by the
 * time `mutate()` returns, nothing has hit the network yet. The
 * caller should `setState` first, then `mutate()`, exactly like
 * before. The difference is that without `mutate()` the state would
 * vanish on refresh; with it, the URL lands on the server and the
 * load-on-mount path re-hydrates the state.
 */
export function mutate(kind: string, options: MutateOptions): MutateHandle {
  const id = generateIntentId();
  const entry: OutboxEntry = {
    id,
    kind,
    method: (options.method ?? 'POST').toUpperCase(),
    url: options.url,
    body: options.body,
    headers: options.headers ?? {},
    attempt: 0,
    nextAt: Date.now(),
    createdAt: Date.now(),
  };
  // Set up the ack promise BEFORE the IDB write so the caller's
  // `await handle.ack` is registered no matter how fast the drainer
  // fires after enqueue.
  let resolveAck: (ack: MutateAck) => void = () => {};
  const ack = new Promise<MutateAck>((resolve) => {
    resolveAck = resolve;
  });
  ackResolvers.set(id, resolveAck);
  if (store) {
    void set(id, entry, store).then(() => {
      log('enqueue', { intentId: id, kind, url: options.url });
      notifySubscribers();
      scheduleDrain(0);
    }).catch((err) => {
      // IDB write itself failed — fall back to plain fire-and-forget
      // fetch so the call still goes out, accepting the original
      // bug-class risk for this one call. Better than dropping it.
      log('enqueue-failed-falling-back', { intentId: id, kind, error: errMsg(err) });
      void fireDirect(entry);
    });
  } else {
    // SSR or browser without IDB (very old / hostile env) — direct
    // fetch with no durability. Should not happen in our supported
    // browser matrix; logged loudly so we notice.
    log('no-idb-direct-send', { intentId: id, kind });
    void fireDirect(entry);
  }
  return { intentId: id, ack };
}

/** Subscribe to outbox state changes. Returns an unsubscribe fn. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  // Fire once on subscribe so the caller sees current state.
  fn(lastState);
  return () => {
    subscribers.delete(fn);
  };
}

/** Current outbox snapshot. `pending` / `failed` are cached from the
 *  last notify (they require an async IDB read to compute); `draining`
 *  and breaker fields are live module state so the caller always
 *  sees up-to-date sync values without having to await. */
export function getState(): OutboxState {
  return {
    pending: lastState.pending,
    failed: lastState.failed,
    draining,
    breaker: breakerState,
    breakerReopenAt,
  };
}

/** Force the drainer to run now. The drainer auto-runs on enqueue, on
 *  focus, and on `online`; callers rarely need this. Exposed for
 *  tests and for the (future) UI "retry now" button. */
export async function drainNow(): Promise<void> {
  await runDrainLoop();
}

/** Test-only — wipe the entire queue and reset the breaker. */
export async function _clearOutboxForTests(): Promise<void> {
  if (store) {
    const all = (await keys(store)) as string[];
    await Promise.all(all.map((k) => del(k, store)));
  }
  _resetBreakerForTests();
}

/** Test-only — reset the breaker to 'closed' without wiping the
 *  queue. Useful when a test wants to exercise per-entry retry logic
 *  beyond the breaker threshold (otherwise the breaker opens after
 *  4 failures and skips the rest of the attempts). */
export function _resetBreakerForTests(): void {
  breakerState = 'closed';
  breakerWindow = [];
  breakerReopenAt = null;
  notifySubscribers();
}

// ── Drainer ──────────────────────────────────────────────────────────

function scheduleDrain(delayMs: number) {
  if (drainTimer !== null) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void runDrainLoop();
  }, delayMs);
}

async function runDrainLoop(): Promise<void> {
  if (!store || draining) return;
  draining = true;
  notifySubscribers();
  log('drain start', {});
  try {
    let nextWakeAt = Infinity;
    const all = (await keys(store)) as string[];
    // Process in insertion order. IDB returns keys in their natural
    // (string) order; our intent ids are UUIDv4-ish (Math.random-
    // backed or crypto.randomUUID), so we sort by the createdAt
    // field on each entry rather than trusting key order.
    const entries: OutboxEntry[] = [];
    for (const k of all) {
      const e = (await get(k, store)) as OutboxEntry | undefined;
      if (e) entries.push(e);
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);

    const now = Date.now();
    // Honor a cooled-down 'open' breaker: transition to half-open so
    // the next attempt is treated as a probe. Done at the top of the
    // loop so a long-running batch doesn't stay 'open' past its
    // cooldown.
    maybeReopenBreaker();

    for (const entry of entries) {
      if (entry.dead) continue;
      if (entry.nextAt > now) {
        nextWakeAt = Math.min(nextWakeAt, entry.nextAt);
        continue;
      }
      // When the breaker is open, skip the actual send to avoid
      // hammering an obviously-down endpoint. The entries stay in the
      // queue; they retry when the breaker reopens. half-open lets
      // ONE attempt through to probe.
      if (breakerState === 'open') {
        if (breakerReopenAt !== null) {
          nextWakeAt = Math.min(nextWakeAt, breakerReopenAt);
        }
        break;
      }
      const result = await sendOnce(entry);
      recordBreakerOutcome(result.outcome !== 'retry');
      if (result.outcome === 'success') {
        await del(entry.id, store);
        resolveAckIfPending(entry.id, {
          ok: true,
          status: result.status ?? 200,
          data: result.data,
        });
        log('drain success', { intentId: entry.id, kind: entry.kind, attempt: entry.attempt });
      } else if (result.outcome === 'terminal-fail') {
        await del(entry.id, store);
        resolveAckIfPending(entry.id, {
          ok: false,
          status: result.status,
          reason: result.reason ?? `http-${result.status}`,
        });
        log('drain dead-4xx', { intentId: entry.id, kind: entry.kind });
      } else if (result.outcome === 'retry') {
        entry.attempt += 1;
        if (entry.attempt >= MAX_ATTEMPTS) {
          entry.dead = true;
          resolveAckIfPending(entry.id, {
            ok: false,
            status: result.status,
            reason: 'exhausted',
          });
          log('drain dead-exhausted', { intentId: entry.id, kind: entry.kind, attempts: entry.attempt });
        } else {
          entry.nextAt = now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (entry.attempt - 1));
          nextWakeAt = Math.min(nextWakeAt, entry.nextAt);
        }
        await set(entry.id, entry, store);
      }
      // half-open → close on the first success; or → open on failure.
      // Done after recordBreakerOutcome above so the window reflects
      // the probe result before we re-evaluate the state.
      if (breakerState === 'half-open') {
        if (result.outcome === 'success') {
          closeBreaker();
        } else {
          openBreaker();
        }
        break;  // Only one probe per drain loop.
      }
    }
    if (Number.isFinite(nextWakeAt)) {
      const delay = Math.max(50, nextWakeAt - Date.now());
      scheduleDrain(delay);
    }
  } catch (err) {
    log('drain crashed', { error: errMsg(err) });
  } finally {
    draining = false;
    notifySubscribers();
    log('drain end', {});
  }
}

/** Result of one send attempt — outcome plus the data the drainer
 *  needs to resolve the ack promise (response data on success,
 *  reason on failure). */
interface SendResult {
  outcome: 'success' | 'retry' | 'terminal-fail';
  status?: number;
  data?: unknown;
  reason?: string;
}

async function sendOnce(entry: OutboxEntry): Promise<SendResult> {
  try {
    const res = await fetch(entry.url, {
      method: entry.method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Intent-Id': entry.id,
        'X-Intent-Kind': entry.kind,
        ...entry.headers,
      },
      body: entry.body !== undefined ? JSON.stringify(entry.body) : undefined,
    });
    if (res.ok) {
      const data = await parseJsonSafe(res);
      return { outcome: 'success', status: res.status, data };
    }
    // 409 Conflict: the server's mutation_ids table reports we already
    // landed this intent. Treat as success — the side effect already
    // happened, the original POST just lost its response over the
    // wire. This is the whole point of intent-id dedup.
    if (res.status === 409) {
      log('drain dedup-hit', { intentId: entry.id, kind: entry.kind });
      const data = await parseJsonSafe(res);
      return { outcome: 'success', status: 409, data };
    }
    // 4xx (other than 409): our payload is bad. Retrying with the same
    // body would just re-fail. Drop with no toast — the optimistic UI
    // state is the caller's; they decide whether to surface it.
    const bodyText = typeof res.text === 'function'
      ? await res.text().catch(() => '')
      : '';
    if (res.status >= 400 && res.status < 500) {
      entry.lastError = `http-${res.status}`;
      return { outcome: 'terminal-fail', status: res.status, reason: bodyText.slice(0, 400) };
    }
    // 5xx — server-side hiccup. Retry with backoff.
    entry.lastError = `http-${res.status}`;
    return { outcome: 'retry', status: res.status, reason: bodyText.slice(0, 400) };
  } catch (err) {
    entry.lastError = errMsg(err);
    return { outcome: 'retry', reason: errMsg(err) };
  }
}

/** Resolve a pending ack promise and remove it from the registry.
 *  Idempotent — a second call for the same id is a no-op so a retry
 *  loop can't double-resolve. */
function resolveAckIfPending(id: string, ack: MutateAck): void {
  const resolve = ackResolvers.get(id);
  if (resolve) {
    ackResolvers.delete(id);
    resolve(ack);
  }
}

/** Best-effort response-body parser. Returns the parsed JSON, or
 *  undefined for empty bodies / non-JSON / unmocked test responses.
 *  Never throws. */
async function parseJsonSafe(res: Response): Promise<unknown> {
  if (typeof res.text !== 'function') return undefined;
  let txt = '';
  try {
    txt = await res.text();
  } catch {
    return undefined;
  }
  if (!txt) return undefined;
  try {
    return JSON.parse(txt);
  } catch {
    return undefined;
  }
}

/** SSR / no-IDB fallback. Best-effort; reverts to the original
 *  fire-and-forget behavior so the call still goes out. Also
 *  resolves the ack promise so a caller's await doesn't hang
 *  forever when we couldn't queue the entry. */
async function fireDirect(entry: OutboxEntry): Promise<void> {
  try {
    const res = await fetch(entry.url, {
      method: entry.method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Intent-Id': entry.id,
        'X-Intent-Kind': entry.kind,
        ...entry.headers,
      },
      body: entry.body !== undefined ? JSON.stringify(entry.body) : undefined,
    });
    if (res.ok || res.status === 409) {
      const data = await parseJsonSafe(res);
      resolveAckIfPending(entry.id, { ok: true, status: res.status, data });
    } else {
      const txt = await res.text().catch(() => '');
      resolveAckIfPending(entry.id, {
        ok: false,
        status: res.status,
        reason: txt.slice(0, 400) || `http-${res.status}`,
      });
    }
  } catch (err) {
    log('direct-send-failed', { intentId: entry.id, error: errMsg(err) });
    resolveAckIfPending(entry.id, { ok: false, reason: errMsg(err) });
  }
}

// ── Subscribers + state ──────────────────────────────────────────────

function notifySubscribers(): void {
  void computeState().then((state) => {
    lastState = state;
    for (const s of subscribers) {
      try {
        s(state);
      } catch (err) {
        log('subscriber-threw', { error: errMsg(err) });
      }
    }
  });
}

async function computeState(): Promise<OutboxState> {
  if (!store) {
    return {
      pending: 0,
      failed: 0,
      draining,
      breaker: breakerState,
      breakerReopenAt,
    };
  }
  try {
    const all = (await keys(store)) as string[];
    let pending = 0;
    let failed = 0;
    for (const k of all) {
      const e = (await get(k, store)) as OutboxEntry | undefined;
      if (!e) continue;
      if (e.dead) failed += 1;
      else pending += 1;
    }
    return {
      pending,
      failed,
      draining,
      breaker: breakerState,
      breakerReopenAt,
    };
  } catch {
    return {
      pending: 0,
      failed: 0,
      draining,
      breaker: breakerState,
      breakerReopenAt,
    };
  }
}

// ── Breaker mechanics ────────────────────────────────────────────────

function recordBreakerOutcome(success: boolean): void {
  breakerWindow.unshift(success);
  if (breakerWindow.length > BREAKER_WINDOW) {
    breakerWindow = breakerWindow.slice(0, BREAKER_WINDOW);
  }
  // Closed → open when failures exceed threshold within the window.
  if (breakerState === 'closed') {
    const failures = breakerWindow.filter((s) => !s).length;
    if (breakerWindow.length >= BREAKER_THRESHOLD && failures >= BREAKER_THRESHOLD) {
      openBreaker();
    }
  }
}

function openBreaker(): void {
  if (breakerState === 'open') return;
  breakerState = 'open';
  breakerReopenAt = Date.now() + BREAKER_COOLDOWN_MS;
  log('breaker open', { reopenAt: breakerReopenAt, windowFailures: breakerWindow.filter((s) => !s).length });
  // Schedule a drain after cooldown so the half-open probe fires
  // automatically without needing user interaction.
  scheduleDrain(BREAKER_COOLDOWN_MS + 50);
  notifySubscribers();
}

function maybeReopenBreaker(): void {
  if (breakerState === 'open' && breakerReopenAt !== null && Date.now() >= breakerReopenAt) {
    breakerState = 'half-open';
    breakerReopenAt = null;
    log('breaker half-open', {});
    notifySubscribers();
  }
}

function closeBreaker(): void {
  if (breakerState === 'closed') return;
  breakerState = 'closed';
  breakerReopenAt = null;
  breakerWindow = [];
  log('breaker closed', {});
  notifySubscribers();
}

// ── Lifecycle hooks ──────────────────────────────────────────────────

if (isBrowser) {
  // Drain when the tab comes back to the foreground — covers a tab
  // that was backgrounded during a transient network blip.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleDrain(0);
    }
  });
  // Drain on reconnect.
  window.addEventListener('online', () => scheduleDrain(0));
  // First-mount drain — picks up entries left over from a previous
  // session (refresh, tab close, browser restart).
  scheduleDrain(0);
}

// ── Utilities ────────────────────────────────────────────────────────

function generateIntentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for very old runtimes. Same shape (lowercase hex with
  // dashes), random source from Math.random — fine for dedup at the
  // scale this app operates (collision probability negligible).
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(event: string, fields: Record<string, unknown>): void {
  // Server-style namespaced log line. Phase 1.5 (tactical
  // observability) hooks Sentry breadcrumbs onto these.
   
  console.info(`${LOG_NS} ${event}`, fields);
}
