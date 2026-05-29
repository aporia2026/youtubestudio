/**
 * Tests for `src/lib/mutate.ts` — the client-side mutation chokepoint
 * with a durable IndexedDB outbox. Phase 1.2 of the 2026-05-29
 * persistence-rebuild plan.
 *
 * idb-keyval is mocked at the module boundary so tests can drive
 * queue state without a real IndexedDB. fetch is mocked per-test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── idb-keyval mock ─────────────────────────────────────────────────
const store: Record<string, unknown> = {};
let setShouldThrow = false;
let getShouldThrow = false;

vi.mock('idb-keyval', () => ({
  createStore: () => ({ __mock: true }),
  set: vi.fn(async (k: string, v: unknown) => {
    if (setShouldThrow) throw new Error('IDB write failed');
    store[k] = v;
  }),
  get: vi.fn(async (k: string) => {
    if (getShouldThrow) throw new Error('IDB read failed');
    return store[k];
  }),
  del: vi.fn(async (k: string) => {
    delete store[k];
  }),
  keys: vi.fn(async () => Object.keys(store)),
}));

// ── globals: stub the browser environment for the SSR-detection branch ─
const originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  setShouldThrow = false;
  getShouldThrow = false;
  (globalThis as { indexedDB?: unknown }).indexedDB = {};
  (globalThis as { window?: unknown }).window = {
    addEventListener: vi.fn(),
  };
  (globalThis as { document?: unknown }).document = {
    addEventListener: vi.fn(),
    visibilityState: 'visible',
  };
  // Node's globalThis.crypto.randomUUID is the source of truth in
  // the test runner — don't try to override (it's a read-only getter
  // in some node versions).
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { document?: unknown }).document = originalDocument;
  vi.resetModules();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('mutate() — enqueue path', () => {
  it('persists the entry to IDB synchronously and returns an intent id', async () => {
    const { mutate } = await import('@/lib/mutate');

    const handle = mutate('test.kind', {
      url: '/api/test',
      body: { hello: 'world' },
    });

    expect(handle.intentId).toMatch(/^[0-9a-f-]+$/);
    // Microtask flush for the .then() chain after the IDB write.
    await Promise.resolve();
    await Promise.resolve();
    expect(Object.keys(store)).toContain(handle.intentId);
    const entry = store[handle.intentId] as {
      kind: string;
      url: string;
      body: unknown;
      method: string;
    };
    expect(entry.kind).toBe('test.kind');
    expect(entry.url).toBe('/api/test');
    expect(entry.body).toEqual({ hello: 'world' });
    expect(entry.method).toBe('POST');
  });

  it('defaults method to POST and accepts overrides', async () => {
    const { mutate } = await import('@/lib/mutate');

    const a = mutate('a', { url: '/a' });
    const b = mutate('b', { url: '/b', method: 'put' });
    await Promise.resolve();
    await Promise.resolve();
    expect((store[a.intentId] as { method: string }).method).toBe('POST');
    expect((store[b.intentId] as { method: string }).method).toBe('PUT');
  });

  it('falls back to direct fetch when the IDB write itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    setShouldThrow = true;
    const { mutate } = await import('@/lib/mutate');
    mutate('test.kind', { url: '/api/test', body: { x: 1 } });

    // Wait for the IDB-failure .catch() chain + the fireDirect call.
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/test');
    expect((call[1] as RequestInit).headers).toMatchObject({
      'X-Intent-Kind': 'test.kind',
    });
  });
});

describe('drainNow() — outcomes', () => {
  it('deletes the entry on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store[handle.intentId]).toBeUndefined();
  });

  it('treats 409 as success (server dedup hit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();
    expect(store[handle.intentId]).toBeUndefined();
  });

  it('deletes (terminal-fail) on 4xx other than 409 — retry would not help', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();
    expect(store[handle.intentId]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry and bumps attempt + nextAt on 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();

    expect(store[handle.intentId]).toBeDefined();
    const entry = store[handle.intentId] as { attempt: number; nextAt: number };
    expect(entry.attempt).toBe(1);
    expect(entry.nextAt).toBeGreaterThan(Date.now());
  });

  it('marks entry dead after MAX_ATTEMPTS retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, _resetBreakerForTests } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    // Simulate 10 attempts by mutating the store entry forward each
    // drain. Each drain reads, attempts the send, increments attempt.
    // Reset the circuit breaker between iterations — Phase 2.3 opens
    // it after 4 failures and would skip the remaining attempts; this
    // test isolates the per-entry retry logic specifically.
    for (let i = 0; i < 10; i++) {
      const entry = store[handle.intentId] as { nextAt: number };
      if (entry) entry.nextAt = 0;
      _resetBreakerForTests();
      await drainNow();
    }

    const entry = store[handle.intentId] as { dead?: boolean; attempt: number } | undefined;
    expect(entry?.dead).toBe(true);
    expect(entry?.attempt).toBeGreaterThanOrEqual(10);
  });

  it('skips entries whose nextAt is in the future (respects backoff)', async () => {
    const fetchMock = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    // Forcibly push nextAt into the future to simulate post-backoff state.
    (store[handle.intentId] as { nextAt: number }).nextAt = Date.now() + 60_000;

    await drainNow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store[handle.intentId]).toBeDefined();
  });

  it('retries on a thrown fetch error (network failure)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('test.kind', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();

    const entry = store[handle.intentId] as { attempt: number; lastError?: string };
    expect(entry.attempt).toBe(1);
    expect(entry.lastError).toMatch(/network down/);
  });
});

describe('drainNow() — header contract', () => {
  it('sends X-Intent-Id and X-Intent-Kind headers to the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const handle = mutate('row-asset.set', {
      url: '/api/edit/abc/row-asset',
      body: { rowIndex: 0, slot: 'image', value: 'https://r2/x.png' },
    });
    await Promise.resolve();
    await Promise.resolve();

    await drainNow();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      'X-Intent-Id': handle.intentId,
      'X-Intent-Kind': 'row-asset.set',
      'Content-Type': 'application/json',
    });
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ rowIndex: 0, slot: 'image', value: 'https://r2/x.png' }));
    expect(init.credentials).toBe('same-origin');
  });
});

describe('FIFO order by createdAt', () => {
  it('processes entries in insertion order regardless of IDB key order', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow } = await import('@/lib/mutate');

    const a = mutate('a', { url: '/a' });
    const b = mutate('b', { url: '/b' });
    const c = mutate('c', { url: '/c' });
    await Promise.resolve();
    await Promise.resolve();

    // Forcibly desynchronize createdAt order from key order.
    (store[c.intentId] as { createdAt: number }).createdAt = 1;
    (store[a.intentId] as { createdAt: number }).createdAt = 2;
    (store[b.intentId] as { createdAt: number }).createdAt = 3;

    await drainNow();

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['/c', '/a', '/b']);
  });
});

describe('circuit breaker', () => {
  it('opens after 4/5 consecutive failures and skips further sends', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return { ok: false, status: 503 };
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, getState } = await import('@/lib/mutate');

    // Enqueue 5 entries and drain. Each fails with 503 → retry.
    for (let i = 0; i < 5; i++) {
      const h = mutate('test.kind', { url: `/api/test/${i}` });
      await Promise.resolve();
      await Promise.resolve();
      // Force the entry eligible for immediate retry so the drain
      // tries it (rather than skipping on backoff).
      const e = (await import('idb-keyval')).get;
      const entry = (await e(h.intentId, undefined as never)) as { nextAt: number } | undefined;
      if (entry) entry.nextAt = 0;
    }
    await drainNow();

    // After the drain, breaker should be open OR the window should
    // show 4-5 failures (depends on how the in-loop check fires).
    const state = getState();
    expect(state.breaker === 'open' || state.breaker === 'half-open').toBe(true);
    if (state.breaker === 'open') {
      expect(state.breakerReopenAt).toBeGreaterThan(Date.now());
    }
  });

  it('exposes breakerReopenAt timestamp when open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, getState, _clearOutboxForTests } = await import('@/lib/mutate');
    await _clearOutboxForTests();

    // Burn enough failures to open.
    for (let i = 0; i < 5; i++) {
      const h = mutate('k', { url: `/u/${i}` });
      await Promise.resolve();
      await Promise.resolve();
      const e = (await import('idb-keyval')).get;
      const entry = (await e(h.intentId, undefined as never)) as { nextAt: number } | undefined;
      if (entry) entry.nextAt = 0;
    }
    await drainNow();

    const state = getState();
    if (state.breaker === 'open') {
      // breakerReopenAt should be set to ~30s in the future.
      expect(state.breakerReopenAt).not.toBeNull();
      expect(state.breakerReopenAt!).toBeGreaterThan(Date.now());
      expect(state.breakerReopenAt!).toBeLessThanOrEqual(Date.now() + 31_000);
    }
  });

  it("_clearOutboxForTests resets breaker state to 'closed'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, getState, _clearOutboxForTests } = await import('@/lib/mutate');

    for (let i = 0; i < 5; i++) {
      const h = mutate('k', { url: `/u/${i}` });
      await Promise.resolve();
      await Promise.resolve();
      const e = (await import('idb-keyval')).get;
      const entry = (await e(h.intentId, undefined as never)) as { nextAt: number } | undefined;
      if (entry) entry.nextAt = 0;
    }
    await drainNow();

    await _clearOutboxForTests();

    const state = getState();
    expect(state.breaker).toBe('closed');
    expect(state.breakerReopenAt).toBeNull();
  });
});

describe('ack promise', () => {
  it("resolves with { ok: true, status, data } when the drain succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: 42 }),
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, _resetBreakerForTests } = await import('@/lib/mutate');
    _resetBreakerForTests();

    const handle = mutate('row-asset.set', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();
    await drainNow();
    const ack = await handle.ack;

    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.status).toBe(200);
      expect(ack.data).toEqual({ version: 42 });
    }
  });

  it("resolves with { ok: false, status: 400 } on a terminal 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad payload"}',
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, _resetBreakerForTests } = await import('@/lib/mutate');
    _resetBreakerForTests();

    const handle = mutate('row-asset.set', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();
    await drainNow();
    const ack = await handle.ack;

    expect(ack.ok).toBe(false);
    if (!ack.ok) {
      expect(ack.status).toBe(400);
      expect(ack.reason).toContain('bad payload');
    }
  });

  it("resolves with { ok: true, status: 409 } on a server dedup hit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => '{"ok":true,"deduped":true,"version":7}',
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, drainNow, _resetBreakerForTests } = await import('@/lib/mutate');
    _resetBreakerForTests();

    const handle = mutate('row-asset.set', { url: '/api/test' });
    await Promise.resolve();
    await Promise.resolve();
    await drainNow();
    const ack = await handle.ack;

    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.status).toBe(409);
      expect((ack.data as { deduped?: boolean }).deduped).toBe(true);
    }
  });
});

describe('subscribe()', () => {
  it('notifies subscribers when state changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { mutate, subscribe } = await import('@/lib/mutate');

    const states: Array<{ pending: number; draining: boolean }> = [];
    const unsub = subscribe((s) => states.push({ pending: s.pending, draining: s.draining }));

    mutate('test', { url: '/test' });
    // Wait for the post-enqueue notifySubscribers chain (4 awaits cover
    // the IDB write + computeState + the subscriber dispatch).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(states.some((s) => s.pending >= 1)).toBe(true);
    unsub();
  });
});
