import { describe, expect, it } from 'vitest';
import { resolveSceneFade } from '@/remotion/fade-resolution';

// ─── resolveSceneFade ────────────────────────────────────────────────
//
// Centralised priority: hard_cut > shotSceneFade > docSceneFadeEnabled
// > historical default (true). A regression on this resolver silently
// changes transition behaviour across every paint_explainer_v1 +
// legacy doc, so every priority level deserves explicit pinning.

describe('resolveSceneFade — historical default', () => {
  it('returns true when every input is undefined (legacy projects)', () => {
    expect(resolveSceneFade({})).toBe(true);
  });
});

describe('resolveSceneFade — doc default', () => {
  it('returns the doc default when no per-row override is set', () => {
    expect(resolveSceneFade({ docSceneFadeEnabled: false })).toBe(false);
    expect(resolveSceneFade({ docSceneFadeEnabled: true })).toBe(true);
  });
});

describe('resolveSceneFade — per-row override', () => {
  it('overrides the doc default when per-row sceneFade is set', () => {
    expect(
      resolveSceneFade({
        shotSceneFade: true,
        docSceneFadeEnabled: false,
      }),
    ).toBe(true);
    expect(
      resolveSceneFade({
        shotSceneFade: false,
        docSceneFadeEnabled: true,
      }),
    ).toBe(false);
  });

  it('overrides the historical default too', () => {
    expect(resolveSceneFade({ shotSceneFade: false })).toBe(false);
  });
});

describe('resolveSceneFade — hard_cut wins everything', () => {
  it("forces false when shotKind === 'hard_cut', ignoring per-row sceneFade", () => {
    expect(
      resolveSceneFade({
        shotKind: 'hard_cut',
        shotSceneFade: true,
        docSceneFadeEnabled: true,
      }),
    ).toBe(false);
  });

  it("forces false when shotKind === 'hard_cut', ignoring doc default", () => {
    expect(
      resolveSceneFade({
        shotKind: 'hard_cut',
        docSceneFadeEnabled: true,
      }),
    ).toBe(false);
  });

  it("forces false even when every other signal points to true", () => {
    expect(
      resolveSceneFade({
        shotKind: 'hard_cut',
      }),
    ).toBe(false);
  });
});

describe('resolveSceneFade — other shotKinds are pass-through', () => {
  it("'static' does not override the fade resolution", () => {
    expect(
      resolveSceneFade({
        shotKind: 'static',
        docSceneFadeEnabled: true,
      }),
    ).toBe(true);
    expect(
      resolveSceneFade({
        shotKind: 'static',
        shotSceneFade: false,
      }),
    ).toBe(false);
  });

  it("'motion' does not override the fade resolution", () => {
    expect(
      resolveSceneFade({
        shotKind: 'motion',
        docSceneFadeEnabled: true,
      }),
    ).toBe(true);
    expect(
      resolveSceneFade({
        shotKind: 'motion',
        shotSceneFade: false,
      }),
    ).toBe(false);
  });

  it('undefined shotKind falls through to other priority levels', () => {
    expect(
      resolveSceneFade({
        shotKind: undefined,
        docSceneFadeEnabled: false,
      }),
    ).toBe(false);
  });
});
