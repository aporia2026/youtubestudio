/**
 * Tests for `src/lib/verb-scrubber.ts`.
 *
 * The scrubber sits between the LLM-emitted per-panel description and
 * the Atlas/Gemini Edit call. Every forbidden verb the LLM smuggled
 * past the prompt directive gets caught here. A regex gap means a
 * "grows" word reaches the model and rescales mid-chain — the exact
 * drift the user complained about.
 */

import { describe, it, expect } from 'vitest';
import { scrubScaleVerbs } from '../src/lib/verb-scrubber';

describe('scrubScaleVerbs', () => {
  it('replaces "grows" in all conjugations', () => {
    const r = scrubScaleVerbs("the cat's paw grows over time, growing into a sword, grew into a beast");
    expect(r.text).not.toMatch(/grows|growing|grew/i);
    expect(r.text).toContain('is drawn in');
  });

  it('replaces "gets bigger / gets larger"', () => {
    const r = scrubScaleVerbs('the warning gets bigger and gets larger');
    expect(r.text).not.toMatch(/gets bigger|gets larger/i);
    expect(r.replacements.find((x) => x.label === 'gets-bigger')?.count).toBe(2);
  });

  it('replaces "becomes bigger / becomes more prominent"', () => {
    const r = scrubScaleVerbs('the icon becomes bigger; the label becomes more prominent');
    expect(r.text).not.toMatch(/becomes bigger|becomes more prominent/i);
  });

  it('replaces "fills the frame" / "dominates the screen"', () => {
    const r = scrubScaleVerbs('the explosion fills the frame and dominates the screen');
    expect(r.text).not.toMatch(/fills the frame|dominates the screen/i);
    expect(r.text).toContain('is positioned at the frame center');
  });

  it('replaces "shrinks" and conjugations', () => {
    const r = scrubScaleVerbs('the icon shrinks; it shrank; the value is shrinking');
    expect(r.text).not.toMatch(/shrinks|shrank|shrinking/i);
    expect(r.text).toContain('is partially erased');
  });

  it('replaces "looms" with structural phrasing', () => {
    const r = scrubScaleVerbs('the shadow looms over the scene');
    expect(r.text).not.toMatch(/looms/i);
    expect(r.text).toContain('drawn larger from the same position');
  });

  it('replaces "expands" → "extends from its position"', () => {
    const r = scrubScaleVerbs('the cloud expands outward');
    expect(r.text).not.toMatch(/\bexpand(s|ed|ing)?\b/i);
    expect(r.text).toContain('extends from its position');
  });

  it('replaces scale-up / scale-down phrasings', () => {
    const r = scrubScaleVerbs('the chart is scaled up and the label is scaled down');
    expect(r.text).not.toMatch(/scaled up|scaled down/i);
  });

  it('returns an empty result for empty input', () => {
    const r = scrubScaleVerbs('');
    expect(r.text).toBe('');
    expect(r.replacements).toEqual([]);
  });

  it('passes through text that has no forbidden verbs', () => {
    const input = 'the cat sits quietly on the bench, then tilts its head 15 degrees right';
    const r = scrubScaleVerbs(input);
    expect(r.text).toBe(input);
    expect(r.replacements).toEqual([]);
  });

  it('does NOT match mid-word (e.g. "growth" must NOT scrub)', () => {
    const r = scrubScaleVerbs('the growth chart shows population over time');
    // "growth" contains "grow" but isn't a verb here. Word boundary
    // anchors must prevent a false positive.
    expect(r.text).toContain('growth');
  });

  it('is case-insensitive on match but preserves surrounding casing', () => {
    const r = scrubScaleVerbs('THE FIRE GROWS and the smoke DOMINATES THE SCREEN');
    expect(r.text).not.toMatch(/GROWS|DOMINATES/i);
  });

  it('counts every replacement for diagnostics', () => {
    const r = scrubScaleVerbs('grows shrinks looms grows');
    const hitMap = Object.fromEntries(r.replacements.map((x) => [x.label, x.count]));
    expect(hitMap['grows']).toBe(2);
    expect(hitMap['shrinks']).toBe(1);
    expect(hitMap['looms']).toBe(1);
  });

  it('handles realistic LLM panel-prompt phrasing', () => {
    const input =
      "Panel 3: the explosion grows from a small spark, fills the screen, dominates the entire frame, then shrinks back to a charred patch";
    const r = scrubScaleVerbs(input);
    expect(r.text).not.toMatch(/grows|fills the screen|dominates the entire frame|shrinks/i);
    expect(r.replacements.length).toBeGreaterThanOrEqual(4);
  });
});
