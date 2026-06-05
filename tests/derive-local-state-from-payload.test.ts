/**
 * Tests for `deriveLocalStateFromPayload` — the helper that the
 * production-doc page uses to hydrate its legacy flag/brand-kit state
 * from the canonical ProjectPayload, both on initial mount and on
 * every subsequent payload version bump.
 *
 * Phase 1a of `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * Round-trip semantics this guards:
 *   - flags.animateScenes / suppressLowerThirds propagate as booleans.
 *   - visualKitOverride colors map to the same flat shape the legacy
 *     brandKit state expects, and titleColor/textColor get the same
 *     contrast derivation that VideoPreviewBrandBar applies on user
 *     input. If the two derivations drift, cross-tab sync silently
 *     shows wrong text colors after a brand-bar change syncs over.
 *   - Missing fields return `undefined` (never default true/false),
 *     so the calling effect knows to leave its current state alone.
 *   - Empty visualKitOverride produces an empty brandKitColors slice
 *     so the caller doesn't trigger a no-op setState.
 */
import { describe, expect, it } from 'vitest';
import { emptyProjectPayload } from '@/lib/project/payload';
import { deriveLocalStateFromPayload } from '@/lib/project/derive-local-state-from-payload';

describe('deriveLocalStateFromPayload — flags', () => {
  it('reads animateScenes and suppressLowerThirds when present', () => {
    const payload = emptyProjectPayload();
    payload.flags.animateScenes = false;
    payload.flags.suppressLowerThirds = true;
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.animateScenes).toBe(false);
    expect(derived.suppressLowerThirds).toBe(true);
  });

  it('returns the default booleans from an empty payload (the default flag block carries both)', () => {
    const payload = emptyProjectPayload();
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.animateScenes).toBe(true);
    expect(derived.suppressLowerThirds).toBe(false);
  });

  it('returns `undefined` for both when flags entries are non-boolean', () => {
    const payload = emptyProjectPayload();
    // Simulate a corrupt payload — the field is present but the wrong shape.
    (payload.flags as unknown as Record<string, unknown>).animateScenes = 'true';
    (payload.flags as unknown as Record<string, unknown>).suppressLowerThirds = 1;
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.animateScenes).toBeUndefined();
    expect(derived.suppressLowerThirds).toBeUndefined();
  });
});

describe('deriveLocalStateFromPayload — brand-kit colors', () => {
  it('returns an empty brandKitColors slice when visualKitOverride is absent', () => {
    const payload = emptyProjectPayload();
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.brandKitColors).toEqual({});
  });

  it('passes through primaryColor when set', () => {
    const payload = emptyProjectPayload();
    payload.visualKitOverride = { v: 1, primaryColor: '#FF6600' };
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.brandKitColors.primaryColor).toBe('#FF6600');
    expect(derived.brandKitColors.backgroundColor).toBeUndefined();
  });

  it('derives near-black title+text colors when backgroundColor is white', () => {
    const payload = emptyProjectPayload();
    payload.visualKitOverride = { v: 1, backgroundColor: '#FFFFFF' };
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.brandKitColors.backgroundColor).toBe('#FFFFFF');
    expect(derived.brandKitColors.titleColor).toBe('#111111');
    expect(derived.brandKitColors.textColor).toBe('#222222');
  });

  it('derives near-white title+text colors when backgroundColor is anything other than white', () => {
    const payload = emptyProjectPayload();
    payload.visualKitOverride = { v: 1, backgroundColor: '#000000' };
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.brandKitColors.backgroundColor).toBe('#000000');
    expect(derived.brandKitColors.titleColor).toBe('#FFFFFF');
    expect(derived.brandKitColors.textColor).toBe('#EEEEEE');
  });

  it('handles both primary and background together', () => {
    const payload = emptyProjectPayload();
    payload.visualKitOverride = {
      v: 1,
      primaryColor: '#1A73E8',
      backgroundColor: '#0B0F1A',
    };
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.brandKitColors).toEqual({
      primaryColor: '#1A73E8',
      backgroundColor: '#0B0F1A',
      titleColor: '#FFFFFF',
      textColor: '#EEEEEE',
    });
  });

  it('does NOT inject undefined keys when only one of primary/background is set', () => {
    const payload = emptyProjectPayload();
    payload.visualKitOverride = { v: 1, primaryColor: '#FF0000' };
    const derived = deriveLocalStateFromPayload(payload);
    // Caller checks `Object.keys(derived.brandKitColors).length > 0`
    // before calling setBrandKit. Sneaky `undefined` keys would inflate
    // the size and trigger a no-op setState every payload tick.
    expect(Object.keys(derived.brandKitColors)).toEqual(['primaryColor']);
  });
});

describe('deriveLocalStateFromPayload — defensive edge cases', () => {
  it('does not throw on a payload whose flags object is replaced with null at runtime', () => {
    const payload = emptyProjectPayload();
    // Hand-rolled corrupt path: a defensive payload that came back from
    // the wire with missing `flags`. `migratePayload` would normally
    // backfill, but the helper must not crash if it doesn't.
    (payload as unknown as { flags: null }).flags = null;
    expect(() => deriveLocalStateFromPayload(payload)).not.toThrow();
    const derived = deriveLocalStateFromPayload(payload);
    expect(derived.animateScenes).toBeUndefined();
    expect(derived.suppressLowerThirds).toBeUndefined();
  });
});
