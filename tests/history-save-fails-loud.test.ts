/**
 * Test the 2026-06-04 fail-loud contract on `saveToServer`.
 *
 * Background: before today, every save failure silently degraded
 * into a synthetic-id local fallback — including the case where
 * `/api/auth/me` returned non-200 and we couldn't even get a scope
 * to queue the entry under. That hid a permanent dead-end behind
 * a normal-looking return value. A real user lost a 180-row CIA
 * doc to this path; see _plans/2026-06-04-prevent-production-doc-
 * silent-loss.md.
 *
 * Contract:
 *   - `loadScope()` returns null  → throw HistorySaveError(no_session)
 *   - POST returns 401/403        → throw HistorySaveError(unauthorized)
 *   - POST returns 4xx other      → throw HistorySaveError(rejected)
 *   - Network throw or 5xx (with valid scope) → queue + return
 *                                                synthetic, no throw
 *                                                (drainPending recovers)
 *
 * The 5xx case is the only one that keeps the offline-queue behavior
 * because it IS recoverable: scope was set, the entry is in
 * __history_pending__, the next list fetch's drain will retry.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── localStorage stub ──────────────────────────────────────────────
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal('localStorage', localStorageStub);

// ── fetch spy with per-test routing ────────────────────────────────
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler = async () => new Response('not configured', { status: 500 });
const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : String(url);
  return fetchHandler(u, init);
});
vi.stubGlobal('fetch', fetchSpy);

// Late import — fixtures need stubs in place BEFORE history.ts evaluates
// its module-level `scopePromise` memo.
const { saveProductionDocEntry, HistorySaveError } = await import('@/lib/history');

const SCOPE_KEY = '__history_scope__';
const PROD_DOC_KEY = 'production_doc_history';
const PENDING_KEY = '__history_pending__';
const SAMPLE_PAYLOAD = {
  title: 'Test Doc',
  niche: 'test',
  topic: 'topic',
  modelId: 'm',
  shotCount: 1,
  totalDuration: '0:30',
  totalWords: 50,
  stylePreset: 'doodle_explainer_2',
};

function resetScopeMemo(): void {
  // history.ts memoizes scopePromise at module scope. We can't reach
  // into it directly, so each test ensures the memo's result diverges
  // from the previous run via localStorage changes — and we use
  // `vi.resetModules` between tests that need a clean scope state.
  store.clear();
}

describe('saveProductionDocEntry — fail-loud contract', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    resetScopeMemo();
    // Each test installs its own routing.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // Clear the global stubs we set at module scope. Without this,
    // `window` and `localStorage` stay overwritten for every test that
    // runs after this file in the same vitest process — and tests
    // that rely on `globalThis.crypto.subtle` (session JWT verify) or
    // a real DOM-less environment fail intermittently.
    vi.unstubAllGlobals();
  });

  it('5xx with valid scope falls back to the offline queue (no throw)', async () => {
    fetchHandler = async (url) => {
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ id: 'user-1', workspace_id: 'ws-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/history') {
        return new Response('boom', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const entry = await saveProductionDocEntry(SAMPLE_PAYLOAD);

    // Synthetic id shape: `<unix-ms>-<random>` — no dashes in UUID
    // positions, no UUID length.
    expect(entry.id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(entry.title).toBe('Test Doc');

    // Entry IS queued and cached because scope is set.
    const pending = JSON.parse(localStorageStub.getItem(PENDING_KEY) || '[]');
    expect(pending).toHaveLength(1);
    expect(pending[0].clientId).toBe(entry.id);
    expect(pending[0].kind).toBe('production_doc');

    const cache = JSON.parse(localStorageStub.getItem(PROD_DOC_KEY) || '{}');
    expect(cache.items?.[0]?.id).toBe(entry.id);
  });

  it('200 success commits the entry and skips the queue', async () => {
    fetchHandler = async (url) => {
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ id: 'user-1', workspace_id: 'ws-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/history') {
        return new Response(
          JSON.stringify({
            item: {
              id: '11111111-2222-4333-8444-555555555555',
              payload: SAMPLE_PAYLOAD,
              client_id: null,
              created_at: new Date('2026-06-04T10:00:00Z').toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const entry = await saveProductionDocEntry(SAMPLE_PAYLOAD);

    // Real UUID returned.
    expect(entry.id).toBe('11111111-2222-4333-8444-555555555555');

    // No pending queue entry.
    const pending = JSON.parse(localStorageStub.getItem(PENDING_KEY) || '[]');
    expect(pending).toEqual([]);
  });

  it('HistorySaveError class shape is correct for downstream instanceof checks', () => {
    const e = new HistorySaveError('msg', 'no_session');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(HistorySaveError);
    expect(e.kind).toBe('no_session');
    expect(e.name).toBe('HistorySaveError');
    expect(e.httpStatus).toBeUndefined();

    const e2 = new HistorySaveError('msg', 'unauthorized', 401);
    expect(e2.kind).toBe('unauthorized');
    expect(e2.httpStatus).toBe(401);
  });
});
