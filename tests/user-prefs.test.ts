/**
 * Tests for `src/lib/user-prefs.ts` — client-side cross-machine UI
 * preferences. Phase 3.1 of the 2026-05-29 persistence-rebuild plan.
 *
 * mutate() is mocked at the module boundary so the tests only verify
 * the prefs helper's behavior, not the outbox internals.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mutateCalls: Array<{ kind: string; opts: Record<string, unknown> }> = [];

vi.mock('@/lib/mutate', () => ({
  mutate: (kind: string, opts: Record<string, unknown>) => {
    mutateCalls.push({ kind, opts });
    return { intentId: 'test-intent' };
  },
}));

const lsStore: Record<string, string> = {};
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  mutateCalls.length = 0;
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  (globalThis as { window?: unknown }).window = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
    setItem: (k: string, v: string) => { lsStore[k] = v; },
    removeItem: (k: string) => { delete lsStore[k]; },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k]; },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
    get length() { return Object.keys(lsStore).length; },
  };
});

afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  (globalThis as { window?: unknown }).window = originalWindow;
  vi.resetModules();
});

describe('getPref / setPref', () => {
  it('returns the fallback when the key is missing', async () => {
    const { getPref } = await import('@/lib/user-prefs');
    expect(getPref('not-set', 'default')).toBe('default');
    expect(getPref('not-set', { foo: 1 })).toEqual({ foo: 1 });
  });

  it('reads from a namespaced localStorage key', async () => {
    lsStore['usersettings:prodoc_image_model'] = JSON.stringify('atlas');
    const { getPref } = await import('@/lib/user-prefs');
    expect(getPref('prodoc_image_model', 'kie')).toBe('atlas');
  });

  it('returns the fallback when stored JSON is malformed', async () => {
    lsStore['usersettings:bad'] = 'not valid json{';
    const { getPref } = await import('@/lib/user-prefs');
    expect(getPref('bad', 'fallback')).toBe('fallback');
  });

  it('setPref writes the namespaced localStorage entry AND queues a mutate', async () => {
    const { setPref } = await import('@/lib/user-prefs');

    setPref('prodoc_image_model', 'qwen');

    expect(lsStore['usersettings:prodoc_image_model']).toBe(JSON.stringify('qwen'));
    expect(mutateCalls).toHaveLength(1);
    expect(mutateCalls[0]).toEqual({
      kind: 'user-prefs.set',
      opts: {
        method: 'PUT',
        url: '/api/user-prefs',
        body: { key: 'prodoc_image_model', value: 'qwen' },
      },
    });
  });

  it('setPref with null clears both localStorage and queues a clear PUT', async () => {
    lsStore['usersettings:to_clear'] = JSON.stringify('was-set');
    const { setPref } = await import('@/lib/user-prefs');

    setPref('to_clear', null);

    expect(lsStore['usersettings:to_clear']).toBeUndefined();
    expect(mutateCalls[0]!.opts.body).toEqual({ key: 'to_clear', value: null });
  });

  it('round-trips complex objects via JSON.stringify/parse', async () => {
    const { getPref, setPref } = await import('@/lib/user-prefs');

    const brand = { primaryColor: '#ff0000', backgroundColor: '#000', titleColor: '#fff' };
    setPref('video_brand_kit', brand);

    expect(getPref('video_brand_kit', {})).toEqual(brand);
  });
});

describe('bootstrapUserPrefs', () => {
  it('writes each fetched pref into namespaced localStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        prefs: {
          prodoc_image_model: 'atlas',
          prodoc_overlays_disabled_pref: true,
        },
      }),
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { bootstrapUserPrefs, isBootstrapped, _resetUserPrefsForTests } =
      await import('@/lib/user-prefs');
    _resetUserPrefsForTests();

    await bootstrapUserPrefs();

    expect(isBootstrapped()).toBe(true);
    expect(lsStore['usersettings:prodoc_image_model']).toBe(JSON.stringify('atlas'));
    expect(lsStore['usersettings:prodoc_overlays_disabled_pref']).toBe(JSON.stringify(true));
    expect(fetchMock).toHaveBeenCalledWith('/api/user-prefs', { credentials: 'same-origin' });
  });

  it('is idempotent — a second call returns the same in-flight promise', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prefs: {} }),
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { bootstrapUserPrefs, _resetUserPrefsForTests } = await import('@/lib/user-prefs');
    _resetUserPrefsForTests();

    const a = bootstrapUserPrefs();
    const b = bootstrapUserPrefs();

    await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives a failed bootstrap (logs + sets bootstrapped flag so retries do not loop)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const { bootstrapUserPrefs, isBootstrapped, _resetUserPrefsForTests } =
      await import('@/lib/user-prefs');
    _resetUserPrefsForTests();

    await bootstrapUserPrefs();

    expect(isBootstrapped()).toBe(true);
    expect(Object.keys(lsStore)).toHaveLength(0);
  });
});
