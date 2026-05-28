import { describe, expect, it } from 'vitest';
import { MOUTH_REMOVAL_PROMPT } from '@/lib/atlas-mouth-removal';

// ─── MOUTH_REMOVAL_PROMPT shape ──────────────────────────────────────
//
// The prompt is the load-bearing string for the entire
// paint_explainer_v1 architecture: Atlas Edit faithfully follows
// surgical-erasure instructions, so the prompt's specific directives
// (preserve eyes, preserve eyebrows, no scar) ARE what makes mouth
// removal work without redrawing the face. A silent edit that drops
// one of those directives would silently regress every character
// shot.
//
// These tests are intentionally checking presence of substrings, not
// the exact prompt wording — small phrasing tweaks (testing better
// language, adding clarifications) shouldn't break the test, but
// dropping a load-bearing directive should.

describe('MOUTH_REMOVAL_PROMPT', () => {
  it('instructs the model to remove the mouth (the actual edit)', () => {
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/remove.*mouth/i);
  });

  it('explicitly forbids leaving a scar / marker / shadow', () => {
    // The viability test's clean output depends on Atlas not leaving
    // any visual artifact where the mouth was. Listed by hand because
    // each one is something Atlas might leave by default.
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/no.*scar/i);
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/no.*marker/i);
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/no.*shadow/i);
  });

  it('explicitly preserves the eyes', () => {
    // MouthSwap composites over the mouth-removed base assuming the
    // eyes haven't moved. Drift on eyes breaks the calibrated mouth
    // anchor on every downstream render.
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/eyes/i);
  });

  it('explicitly preserves the eyebrows', () => {
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/eyebrows/i);
  });

  it('explicitly preserves the head outline', () => {
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/head/i);
  });

  it('explicitly preserves the background', () => {
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/background/i);
  });

  it("asserts the rest of the image must be 'identical' to the input", () => {
    // The 'IDENTICAL' (uppercase) directive is the strongest signal
    // Atlas takes seriously. Dropping it weakens the preservation
    // guarantee.
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/identical/i);
  });

  it('preserves the hand-drawn doodle style', () => {
    // Atlas Edit defaults to a more polished cartoon look when not
    // told otherwise; the doodle-style directive holds the wobbly
    // black-outline aesthetic.
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/(hand-drawn|doodle)/i);
  });

  it('forbids redrawing any line that is not the mouth', () => {
    // Catches Atlas's tendency to "improve" untouched lines when it's
    // editing. The line-by-line preservation directive is what stops
    // the cumulative drift across many mouth-removed bases.
    expect(MOUTH_REMOVAL_PROMPT).toMatch(/do not redraw|don.t redraw/i);
  });

  it('fits within a comfortable Atlas prompt budget', () => {
    // Atlas accepts long prompts, but a prompt over ~2000 chars is a
    // smell — the directives have probably collected redundancy that
    // dilutes the load-bearing instructions.
    expect(MOUTH_REMOVAL_PROMPT.length).toBeGreaterThan(200);
    expect(MOUTH_REMOVAL_PROMPT.length).toBeLessThan(2000);
  });
});
