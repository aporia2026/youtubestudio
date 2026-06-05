/**
 * Derives the production-doc page's "legacy local state" (the flag
 * booleans and the flat brand-kit colors) from a canonical
 * `ProjectPayload`.
 *
 * Phase 1a of `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * Why this exists as a separate file: the production-doc page mounts
 * the hydration in TWO effects — the one-shot initial hydration and an
 * ongoing payload-rehydration effect that re-applies these fields when
 * `project.version` advances. Without a shared helper the two effects
 * drift, and a bug in either one shows up as "the flag stops syncing
 * after the second cross-tab update." Centralizing the derivation
 * makes it testable (vitest, no React) and keeps the two effects
 * bit-identical.
 *
 * Pure function — no side effects, no React. Safe to call in any
 * environment.
 */
import type { BrandKit } from '@/remotion/types';
import type { ProjectPayload } from './payload';

/** Subset of legacy local state the production-doc page derives from
 *  the canonical payload. `undefined` means "the payload doesn't carry
 *  this field" → the caller should leave their current state alone. */
export interface DerivedLocalState {
  animateScenes: boolean | undefined;
  suppressLowerThirds: boolean | undefined;
  /** Flat `Partial<BrandKit>` slice derived from
   *  `visualKitOverride.primaryColor` / `backgroundColor`. Empty when
   *  the override carries neither. `titleColor`/`textColor` are
   *  computed from `backgroundColor` using the same contrast rule the
   *  `VideoPreviewBrandBar` `update()` function applies. */
  brandKitColors: Partial<BrandKit>;
}

/**
 * Pull the flag booleans and brand-kit colors out of a payload.
 *
 * Returns a stable shape: callers can spread `brandKitColors` into
 * their local brand-kit state and apply `animateScenes` /
 * `suppressLowerThirds` whenever they aren't `undefined`.
 */
export function deriveLocalStateFromPayload(payload: ProjectPayload): DerivedLocalState {
  const flags = payload.flags;
  const animateScenes =
    flags && typeof flags.animateScenes === 'boolean' ? flags.animateScenes : undefined;
  const suppressLowerThirds =
    flags && typeof flags.suppressLowerThirds === 'boolean'
      ? flags.suppressLowerThirds
      : undefined;

  const brandKitColors: Partial<BrandKit> = {};
  const vKO = payload.visualKitOverride;
  if (vKO) {
    if (vKO.primaryColor) brandKitColors.primaryColor = vKO.primaryColor;
    if (vKO.backgroundColor) {
      brandKitColors.backgroundColor = vKO.backgroundColor;
      // Same contrast rule as VideoPreviewBrandBar.update() in the
      // production-doc page. White background → near-black text; any
      // other background → near-white text. Keeps the two derivation
      // paths bit-identical.
      brandKitColors.titleColor = vKO.backgroundColor === '#FFFFFF' ? '#111111' : '#FFFFFF';
      brandKitColors.textColor = vKO.backgroundColor === '#FFFFFF' ? '#222222' : '#EEEEEE';
    }
  }

  return { animateScenes, suppressLowerThirds, brandKitColors };
}
