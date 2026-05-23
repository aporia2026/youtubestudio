/**
 * Module-level gesture-active counter.
 *
 * Lets the autosave's conflict handler check whether a user gesture
 * (transform drag, resize, rotate) is currently in progress and DEFER
 * auto-reloading if so. Without this, a stale-version PATCH that
 * happens to fire mid-drag returns 409, the conflict handler resets
 * the editor's state, the drag's local values get wiped, and the user
 * perceives "drag doesn't work."
 *
 * Why a module-level ref instead of a React hook:
 *   - The conflict handler lives in `useEditorStore`'s closure and
 *     fires from inside a setTimeout — there's no clean way to read
 *     React state from there without re-creating the hook on every
 *     gesture toggle.
 *   - Gesture state is fundamentally global to the page (only one
 *     pointer at a time) so a module-level singleton matches the
 *     domain.
 *   - Counter (not boolean) because multiple TransformOverlay-like
 *     gesture sources may eventually layer; we want "active" to be
 *     true if ANY is in flight.
 *
 * Always pair `markGestureStart` with `markGestureEnd` (or use a
 * try/finally pattern) so the counter doesn't drift positive after
 * a thrown handler. `forceReset()` is provided as an escape hatch
 * for tests.
 */

let activeGestureCount = 0;

export function markGestureStart(label?: string): void {
  activeGestureCount += 1;
  if (typeof console !== 'undefined') {
    console.info('[editor gesture] start', { label, active: activeGestureCount });
  }
}

export function markGestureEnd(label?: string): void {
  activeGestureCount = Math.max(0, activeGestureCount - 1);
  if (typeof console !== 'undefined') {
    console.info('[editor gesture] end', { label, active: activeGestureCount });
  }
}

export function isGestureActive(): boolean {
  return activeGestureCount > 0;
}

/** Test-only escape hatch. */
export function _resetGestureCountForTests(): void {
  activeGestureCount = 0;
}
