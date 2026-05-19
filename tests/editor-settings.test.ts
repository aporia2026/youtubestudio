/**
 * Tests for the per-device editor preferences module.
 *
 * Phase 4b of `_plans/2026-05-19-editor-production-doc-parity.md`.
 * The module wraps a tiny localStorage surface; the tests guard:
 *
 *   - SSR-safety: every accessor returns the default when window /
 *     localStorage is unavailable.
 *   - Defaults: each getter returns its documented default when no
 *     key is stored.
 *   - Round-trip: setX → getX returns the value.
 *   - Clamping: zoom level outside 1..10 falls back to default.
 *   - Boolean coercion: '1' / 'true' both read as `true`, anything
 *     else as `false`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __testing,
  getAutoRegenCaptions,
  getDefaultZoomLevel,
  getShowShortcutHints,
  getShowThumbnails,
  setAutoRegenCaptions,
  setDefaultZoomLevel,
  setShowShortcutHints,
  setShowThumbnails,
} from '@/lib/editor/settings';

class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

declare global {
  var localStorage: MockLocalStorage | undefined;
}

beforeEach(() => {
  // happy-dom / jsdom may or may not be the active test env; the
  // module reads `window.localStorage` so we attach to `globalThis`
  // and let the safeRead helper see it as `window.localStorage`.
  const ls = new MockLocalStorage();
  (globalThis as unknown as { window: { localStorage: MockLocalStorage } }).window = {
    localStorage: ls,
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('editor settings — defaults', () => {
  it('default zoom level is 5 when unset', () => {
    expect(getDefaultZoomLevel()).toBe(__testing.DEFAULT_ZOOM_LEVEL);
    expect(__testing.DEFAULT_ZOOM_LEVEL).toBe(5);
  });

  it('showThumbnails default is true', () => {
    expect(getShowThumbnails()).toBe(__testing.DEFAULT_SHOW_THUMBNAILS);
    expect(__testing.DEFAULT_SHOW_THUMBNAILS).toBe(true);
  });

  it('showShortcutHints default is true', () => {
    expect(getShowShortcutHints()).toBe(__testing.DEFAULT_SHOW_SHORTCUT_HINTS);
    expect(__testing.DEFAULT_SHOW_SHORTCUT_HINTS).toBe(true);
  });

  it('autoRegenCaptions default is false', () => {
    expect(getAutoRegenCaptions()).toBe(__testing.DEFAULT_AUTO_REGEN_CAPTIONS);
    expect(__testing.DEFAULT_AUTO_REGEN_CAPTIONS).toBe(false);
  });
});

describe('editor settings — round-trip', () => {
  it('zoom level setter persists and reads back', () => {
    setDefaultZoomLevel(7);
    expect(getDefaultZoomLevel()).toBe(7);
  });

  it('zoom level clamps to 1..10 (low)', () => {
    setDefaultZoomLevel(0);
    expect(getDefaultZoomLevel()).toBe(1);
  });

  it('zoom level clamps to 1..10 (high)', () => {
    setDefaultZoomLevel(99);
    expect(getDefaultZoomLevel()).toBe(10);
  });

  it('zoom level rounds non-integer input', () => {
    setDefaultZoomLevel(4.7);
    expect(getDefaultZoomLevel()).toBe(5);
  });

  it('zoom level returns default when stored value is malformed', () => {
    (globalThis as unknown as { window: { localStorage: MockLocalStorage } }).window.localStorage.setItem(
      __testing.KEY_DEFAULT_ZOOM,
      'not-a-number',
    );
    expect(getDefaultZoomLevel()).toBe(__testing.DEFAULT_ZOOM_LEVEL);
  });

  it('boolean setters round-trip', () => {
    setShowThumbnails(false);
    expect(getShowThumbnails()).toBe(false);
    setShowThumbnails(true);
    expect(getShowThumbnails()).toBe(true);

    setShowShortcutHints(false);
    expect(getShowShortcutHints()).toBe(false);

    setAutoRegenCaptions(true);
    expect(getAutoRegenCaptions()).toBe(true);
  });

  it('boolean readers accept legacy "true" string as well as "1"', () => {
    const ls = (globalThis as unknown as { window: { localStorage: MockLocalStorage } }).window
      .localStorage;
    ls.setItem(__testing.KEY_SHOW_THUMBNAILS, 'true');
    expect(getShowThumbnails()).toBe(true);
    ls.setItem(__testing.KEY_SHOW_THUMBNAILS, '1');
    expect(getShowThumbnails()).toBe(true);
    ls.setItem(__testing.KEY_SHOW_THUMBNAILS, '0');
    expect(getShowThumbnails()).toBe(false);
    ls.setItem(__testing.KEY_SHOW_THUMBNAILS, 'anything-else');
    expect(getShowThumbnails()).toBe(false);
  });
});

describe('editor settings — SSR safety', () => {
  it('returns defaults when window is undefined', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(getDefaultZoomLevel()).toBe(__testing.DEFAULT_ZOOM_LEVEL);
    expect(getShowThumbnails()).toBe(__testing.DEFAULT_SHOW_THUMBNAILS);
    expect(getShowShortcutHints()).toBe(__testing.DEFAULT_SHOW_SHORTCUT_HINTS);
    expect(getAutoRegenCaptions()).toBe(__testing.DEFAULT_AUTO_REGEN_CAPTIONS);
  });

  it('setters are no-ops when window is undefined (do not throw)', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(() => setDefaultZoomLevel(8)).not.toThrow();
    expect(() => setShowThumbnails(false)).not.toThrow();
    expect(() => setShowShortcutHints(false)).not.toThrow();
    expect(() => setAutoRegenCaptions(true)).not.toThrow();
  });
});
