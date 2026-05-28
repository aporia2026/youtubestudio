/**
 * Flex Icon Grid — browser-side custom-font registry (Phase 4.10).
 *
 * Module-level singleton with refcounting. Two or more surfaces on
 * the same page (panel + live preview, or two panels in a side-by-
 * side layout) used to each maintain a per-component FontFace Map,
 * and a single shared URL would be `document.fonts.add()`-ed and
 * `delete()`-d independently. When one surface unmounted, it would
 * remove a face the other surface still needed — Phase 4.9 caveat 1.
 *
 * Contract
 *  - `acquireCustomFont(url)` increments a refcount keyed by `url`.
 *    On the FIRST acquire the FontFace is created + loaded + added to
 *    `document.fonts`. Subsequent acquires are O(1) no-ops.
 *  - `releaseCustomFont(url)` decrements the refcount. On the LAST
 *    release the FontFace is removed from `document.fonts` and
 *    dropped from the registry.
 *  - Both calls are SSR-safe — they bail when `document` is missing.
 *
 * Family name agreement
 *  - The registry uses the same `customFontFamilyName(url)` hash as
 *    the rest of the format, so a `<text>` element styled with
 *    `font-family: customFontFamilyName(url)` picks up the loaded
 *    face the moment it resolves.
 *
 * Tests
 *  - `_resetFontRegistryForTests()` clears refcounts + faces so a
 *    test suite can isolate state. Production code never calls it.
 */

import { customFontFamilyName } from './flex-icon-grid-font-family';

const refCounts = new Map<string, number>();
const faces = new Map<string, FontFace>();

/**
 * Increment the refcount for `url`. The first acquire loads the font;
 * subsequent acquires are cheap no-ops. Safe to call from SSR / non-
 * DOM contexts — bails silently when `document.fonts` isn't available.
 */
export function acquireCustomFont(url: string): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const current = refCounts.get(url) ?? 0;
  refCounts.set(url, current + 1);
  if (current > 0) return;
  const family = customFontFamilyName(url);
  const face = new FontFace(family, `url(${url})`);
  faces.set(url, face);
  void face.load().then((loaded) => {
    // Guard against a release that fired during the async load — if
    // every subscriber already left, drop the loaded face instead of
    // smuggling it into the registry under a zero refcount.
    if ((refCounts.get(url) ?? 0) > 0) document.fonts.add(loaded);
  }).catch(() => {
    // Silent — the picker chip and live preview fall back to the
    // generic font stack when the load fails. The render log already
    // surfaces the failure via `fontWarnings` on the server side.
  });
}

/**
 * Decrement the refcount for `url`. The LAST release removes the
 * FontFace from `document.fonts` and drops it from the registry.
 * Releasing an unknown URL is a no-op (so unmount cleanups can be
 * defensive without crashing).
 */
export function releaseCustomFont(url: string): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const current = refCounts.get(url) ?? 0;
  if (current <= 0) return;
  if (current === 1) {
    refCounts.delete(url);
    const face = faces.get(url);
    if (face) {
      try { document.fonts.delete(face); } catch { /* ignore */ }
      faces.delete(url);
    }
    return;
  }
  refCounts.set(url, current - 1);
}

/** Diagnostic — exposed for tests / debug overlays. */
export function _getFontRegistryStateForTests(): {
  refCounts: Record<string, number>;
  faces: number;
} {
  return {
    refCounts: Object.fromEntries(refCounts),
    faces: faces.size,
  };
}

/** Test-only: drain the registry so a test suite can isolate state
 *  between cases. Production code never calls this. */
export function _resetFontRegistryForTests(): void {
  refCounts.clear();
  faces.clear();
}
