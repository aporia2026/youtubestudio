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

/** Hard ceiling on FontFace load time. Phase 4.11 — a wedged R2
 *  fetch (DNS, slow region, signed-URL expiry) would otherwise leave
 *  the FontFace promise pending indefinitely, holding the refcount
 *  open even after every subscriber has unmounted. After this
 *  timeout we drop the face from the registry so the chip falls back
 *  cleanly to the generic stack and the next `acquireCustomFont` call
 *  for the same URL gets a fresh load attempt.
 *
 *  Phase 4.12 — configurable via `NEXT_PUBLIC_FLEX_FONT_LOAD_TIMEOUT_MS`.
 *  Default 8 s; slow regions or large multi-MB faces may need 15–30 s
 *  on first cold load. Clamped to [1 s, 60 s] so a misconfigured
 *  env can't disable the timeout entirely or set a pathologically
 *  short one. */
const DEFAULT_FONT_LOAD_TIMEOUT_MS = 8000;
const FONT_LOAD_TIMEOUT_MS = (() => {
  const raw = process.env.NEXT_PUBLIC_FLEX_FONT_LOAD_TIMEOUT_MS;
  if (!raw) return DEFAULT_FONT_LOAD_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_LOAD_TIMEOUT_MS;
  return Math.max(1000, Math.min(60_000, parsed));
})();

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
  // Race the load against a hard timeout so a wedged fetch can't pin
  // the registry forever. The face object itself remains in `faces`
  // only while the load is in flight; on timeout / error we drop it
  // so a subsequent acquire for the same URL retries cleanly.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('font load timeout')), FONT_LOAD_TIMEOUT_MS);
  });
  void Promise.race([face.load(), timeoutPromise])
    .then((loaded) => {
      // Guard against a release that fired during the async load — if
      // every subscriber already left, drop the loaded face instead of
      // smuggling it into the registry under a zero refcount.
      if ((refCounts.get(url) ?? 0) > 0) document.fonts.add(loaded as FontFace);
    })
    .catch(() => {
      // Drop the failed face from the registry so a future acquire
      // can retry. The picker chip and live preview fall back to the
      // generic font stack when the load fails; the render log
      // surfaces the failure via `fontWarnings` on the server side.
      faces.delete(url);
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
