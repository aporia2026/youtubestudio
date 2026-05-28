import { describe, expect, it } from 'vitest';
import { getVariantPreservationHint } from '@/lib/production-doc-flags';

// Bug 2 (Phase 1.6 deferred) — count-precision hint extension. Sodder
// QA flagged Atlas Edit thinning crowds under subtraction-style variant
// prompts; the doodle_explainer_2 preservation hint now explicitly
// names figures / people / characters as a protected axis with an
// explicit-ask exception. Spec:
// _plans/2026-05-28-doodle-2-variant-count-precision.md.

describe('getVariantPreservationHint', () => {
  it('returns the doodle_explainer_2-specific hint with figure-count language', () => {
    const hint = getVariantPreservationHint('doodle_explainer_2');
    // The original protected axes — must still be named.
    expect(hint).toContain('Composition');
    expect(hint).toContain('positions');
    expect(hint).toContain('proportions');
    expect(hint).toContain('line style');
    // The new count-precision axes added by this fix.
    expect(hint).toContain('figures');
    expect(hint).toContain('people');
    expect(hint).toContain('characters');
  });

  it('carves out an EXPLICIT-ask exception so genuine add/remove edits still work', () => {
    const hint = getVariantPreservationHint('doodle_explainer_2');
    // The exception is the load-bearing part — without it, an explicit
    // "add a third sailor" instruction would be paradoxically blocked.
    expect(hint).toMatch(/except.*EXPLICITLY/i);
    expect(hint).toMatch(/add or remove a specific person/i);
  });

  it('forbids silent crowd-thinning and bystander-adding', () => {
    // The exact failure mode the user reported on Sodder b30b8d1e:
    // base shows 7 figures, variant shows 5. Hint must explicitly
    // forbid both directions.
    const hint = getVariantPreservationHint('doodle_explainer_2');
    expect(hint).toMatch(/Do not silently thin crowds or add bystanders/);
  });

  it('falls back to the safe default for unknown styles', () => {
    const def = getVariantPreservationHint('some-other-style');
    // The default hint stays unchanged (no figure-count language) until
    // another style reports a similar issue and gets its own entry.
    expect(def).toContain('Composition');
    expect(def).toContain('positions');
    expect(def).not.toContain('Do not silently thin');
  });

  it('falls back to the default for null / undefined / empty styleId', () => {
    const a = getVariantPreservationHint(null);
    const b = getVariantPreservationHint(undefined);
    const c = getVariantPreservationHint('');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toContain('Composition');
  });
});
