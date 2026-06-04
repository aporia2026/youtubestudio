/**
 * Test for `updateProductionDocEntryCacheOnly` — the surgical
 * replacement for the legacy `updateProductionDocEntry` call sites
 * on the production-doc page.
 *
 * The bug the helper closes: the legacy PATCH at /api/history/[id]
 * blindly UPDATEs `user_history.payload = ${...cache[idx], ...patch}`.
 * When the localStorage cache lagged the canonical `useProject` state
 * (stale `doc.rows`, missing flags), every legacy PATCH wiped the
 * canonical row. Users saw the editor open empty + their production
 * doc came back blank when they navigated back.
 *
 * This test pins the contract: the helper updates the cache and
 * MUST NOT issue any network call. If it ever does, the legacy
 * data-loss path is reopened.
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

// Both `window` and `localStorage` must exist so isBrowser() returns true.
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal('localStorage', localStorageStub);

// ── fetch spy ──────────────────────────────────────────────────────
const fetchSpy = vi.fn(async (url: string) => {
  // The only network call the helper itself should NEVER make is the
  // legacy /api/history/[id] PATCH. /api/auth/me is allowed (it's how
  // loadScope() figures out the cache envelope).
  if (url === '/api/auth/me') {
    return new Response(
      JSON.stringify({ id: 'user-1', workspace_id: 'ws-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  // Any other URL would be a regression — fail loudly.
  throw new Error(`unexpected fetch: ${url}`);
});
vi.stubGlobal('fetch', fetchSpy);

// Import AFTER stubs so the module's module-level `scopePromise` cache
// closes over the stubbed fetch.
const { updateProductionDocEntryCacheOnly } = await import('@/lib/history');

// Cache key + scope shape lifted from src/lib/history.ts (PROD_DOC_KEY,
// scope = `${workspace_id}:${collaborator_id}`, envelope { scope, v: 1, items }).
const PROD_DOC_KEY = 'production_doc_history';
const SCOPE = 'ws-1:user-1';
const SCOPE_KEY = '__history_scope__';

function seedCache(items: unknown[]): void {
  localStorageStub.setItem(SCOPE_KEY, SCOPE);
  localStorageStub.setItem(
    PROD_DOC_KEY,
    JSON.stringify({ scope: SCOPE, v: 1, items }),
  );
}

function readCacheItems(): unknown[] {
  const raw = localStorageStub.getItem(PROD_DOC_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { items?: unknown[] };
  return parsed.items ?? [];
}

describe('updateProductionDocEntryCacheOnly', () => {
  beforeEach(() => {
    store.clear();
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // Clear module-scope global stubs so later tests in the same
    // vitest process don't inherit our window / localStorage / fetch
    // overrides — particularly session.test.ts which needs the real
    // globalThis.crypto.subtle for JWT verify.
    vi.unstubAllGlobals();
  });

  it('updates the local cache row without issuing a PATCH to /api/history/[id]', async () => {
    seedCache([
      {
        id: 'doc-abc',
        timestamp: 1,
        title: 'Doc A',
        rowImages: { 0: 'old.png' },
        // `doc` is intentionally absent — the legacy PATCH would have
        // sent `doc: undefined` to the server and wiped real rows; this
        // test asserts the helper never makes that call.
      },
      { id: 'doc-xyz', timestamp: 2, title: 'Doc B' },
    ]);

    await updateProductionDocEntryCacheOnly('doc-abc', {
      rowImages: { 0: 'new.png', 1: 'second.png' },
    });

    const items = readCacheItems() as Array<{
      id: string;
      title: string;
      rowImages?: Record<number, string>;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('doc-abc');
    expect(items[0].rowImages).toEqual({ 0: 'new.png', 1: 'second.png' });
    expect(items[1].id).toBe('doc-xyz');

    // The critical assertion: NO PATCH to /api/history/[id]. The auth
    // probe (/api/auth/me) may or may not fire depending on whether
    // loadScope's module-level memo has already resolved from a prior
    // call. If this ever sees the legacy PATCH URL the dual-write
    // data-loss path is back.
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls).not.toContain('/api/history/doc-abc');
    expect(urls.every((u) => u === '/api/auth/me')).toBe(true);
  });

  it('is a no-op on cache miss (no entry with that id) — no PATCH either', async () => {
    seedCache([{ id: 'doc-other', timestamp: 1, title: 'Other' }]);

    await updateProductionDocEntryCacheOnly('doc-missing', {
      rowImages: { 0: 'x.png' },
    });

    const items = readCacheItems() as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(['doc-other']);

    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls).not.toContain('/api/history/doc-missing');
    expect(urls.every((u) => u === '/api/auth/me')).toBe(true);
  });

  it('merges shallow — the patch overwrites only the keys it carries, never `doc`', async () => {
    // This is the exact regression class that caused the wipe: a
    // stale cache `doc` should NEVER be reflected back to the server,
    // and the helper preserves it locally untouched (since the patch
    // doesn't carry `doc`).
    seedCache([
      {
        id: 'doc-abc',
        timestamp: 1,
        title: 'Doc A',
        doc: { rows: [{ visual_description: 'kept' }] },
        rowImages: {},
      },
    ]);

    await updateProductionDocEntryCacheOnly('doc-abc', {
      rowImages: { 0: 'new.png' },
    });

    const items = readCacheItems() as Array<{
      id: string;
      title: string;
      doc?: { rows: Array<{ visual_description: string }> };
      rowImages?: Record<number, string>;
    }>;
    expect(items[0].doc?.rows).toEqual([{ visual_description: 'kept' }]);
    expect(items[0].rowImages).toEqual({ 0: 'new.png' });
    expect(items[0].title).toBe('Doc A');
  });
});
