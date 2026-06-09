import { describe, expect, it } from 'vitest';

import { buildPanelFillPrompt, parsePanelFillResponse } from '@/lib/motion-collage-panel-fill';

// Pure-helper tests for the motion_collage panel auto-fill. The HTTP route
// + the LLM call are covered by end-to-end QA; here we pin the two pure
// pieces: prompt assembly and response parsing.
// See _plans/2026-06-01-motion-collage-panel-autofill.md.

describe('buildPanelFillPrompt', () => {
  it('reports the expected panel count = cols × rows', () => {
    const { expected } = buildPanelFillPrompt({
      scriptText: 'George ran from the house to the truck.',
      cols: 3,
      rows: 2,
    });
    expect(expected).toBe(6);
  });

  it('embeds the same-scene contract and the JSON-array output contract', () => {
    const { system, user } = buildPanelFillPrompt({
      scriptText: 'The ship heeled hard to port.',
      cols: 2,
      rows: 2,
    });
    expect(system).toMatch(/SAME scene/i);
    expect(system).toMatch(/ONLY the moving element advances/i);
    expect(system).toMatch(/EXACTLY 4 strings/);
    expect(user).toMatch(/The ship heeled hard to port\./);
    expect(user).toMatch(/JSON array of 4 strings/);
  });

  it('injects visual description and base image prompt when provided', () => {
    const { user } = buildPanelFillPrompt({
      scriptText: 'beat',
      visualDescription: 'wide harbor view',
      baseImagePrompt: 'doodle of a ship',
      cols: 2,
      rows: 2,
    });
    expect(user).toMatch(/VISUAL DESCRIPTION: wide harbor view/);
    expect(user).toMatch(/SCENE \/ IMAGE PROMPT FOR THIS BEAT: doodle of a ship/);
  });

  it('lists existing panels and marks blanks as [WRITE THIS] when some are filled', () => {
    const { user } = buildPanelFillPrompt({
      scriptText: 'beat',
      cols: 2,
      rows: 2,
      existingPanels: ['ship upright', '', 'ship at 50 deg', ''],
    });
    expect(user).toMatch(/EXISTING PANELS/);
    expect(user).toMatch(/ship upright/);
    expect(user).toMatch(/\[WRITE THIS\]/);
  });

  it('omits the existing-panels block entirely when all panels are blank', () => {
    const { user } = buildPanelFillPrompt({
      scriptText: 'beat',
      cols: 2,
      rows: 2,
      existingPanels: ['', '', '', ''],
    });
    expect(user).not.toMatch(/EXISTING PANELS/);
    expect(user).not.toMatch(/\[WRITE THIS\]/);
  });

  it('includes the character bible when descriptions are supplied', () => {
    const { user } = buildPanelFillPrompt({
      scriptText: 'beat',
      cols: 2,
      rows: 2,
      characterDescriptions: { george: 'tall stick figure in a red hat' },
    });
    expect(user).toMatch(/CHARACTER REFERENCE/);
    expect(user).toMatch(/george: tall stick figure in a red hat/);
  });

  // ─── ELEMENT-SCALE LOCK (2026-06-02 fix) ────────────────────────────
  // The #1 motion_collage failure mode was the panel-fill LLM picking
  // "thing grows in size" as the motion (warning triangle small → huge
  // across panels). The system prompt forbids scale-based motion
  // explicitly and lists allowed motion types. See _plans/.
  describe('element-scale lock', () => {
    it('forbids scale-based motion in the system prompt', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      expect(system).toMatch(/ELEMENT-SCALE IS LOCKED/);
      expect(system).toMatch(/never be the element growing/i);
      expect(system).toMatch(/keep the SAME SIZE across every panel/);
    });

    it('enumerates the forbidden scale-change words', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      for (const word of ['grows', 'gets bigger', 'enlarges', 'expands', 'shrinks', 'fills the frame']) {
        expect(system).toContain(word);
      }
    });

    it('lists allowed motion types (translation, rotation, pose, progressive stroke)', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      expect(system).toMatch(/ALLOWED motions/);
      expect(system).toMatch(/walking|sliding|raising|rotating|pointing/i);
    });

    it('shows a concrete GOOD/BAD example for the warning-sign scale failure mode', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      // GOOD example uses translation ("slides up"); BAD example uses
      // the exact forbidden pattern ("now LARGER and more prominent").
      expect(system).toMatch(/slides up/i);
      expect(system).toMatch(/LARGER and more prominent/);
    });
  });

  // ─── MOTION DELTA (2026-06-09 fix) ────────────────────────────────
  // Second-biggest motion_collage failure mode: the LLM evenly divides
  // a motion across panels ("at start" → "1/3 way" → "2/3 way" → "at
  // end") which forces the image model to re-imagine composition every
  // step. The new MOTION DELTA section pushes for tiny per-step changes
  // even if the final panel doesn't fully complete the action.
  describe('motion-delta size guidance', () => {
    it('includes the MOTION DELTA section calling out tiny per-step changes', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 3,
        rows: 3,
      });
      expect(system).toMatch(/MOTION DELTA/);
      expect(system).toMatch(/SMALL increment|small increment|TINY/);
    });

    it('shows the anti-pattern (evenly-divided big deltas) and the good pattern (tiny body-mechanics deltas)', () => {
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      // Anti-pattern marker — the canonical "1/3 across" → "2/3 across"
      // failure mode, named so a future reader can grep the prompt
      // copy against the test.
      expect(system).toMatch(/ANTI-PATTERN/);
      expect(system).toMatch(/1\/3 across/);
      // Good pattern uses body-mechanics granularity (foot lifting,
      // foot landing) rather than fractional progress.
      expect(system).toMatch(/GOOD PATTERN/);
      expect(system).toMatch(/foot/i);
    });

    it('tells the model it is acceptable for the final panel to NOT fully complete the action', () => {
      // The key permission that lets the model write tiny deltas
      // without feeling like it's failing the brief.
      const { system } = buildPanelFillPrompt({
        scriptText: 'beat',
        cols: 2,
        rows: 2,
      });
      expect(system).toMatch(/almost complete|ALMOST complete/i);
    });
  });
});

describe('parsePanelFillResponse', () => {
  it('parses a bare JSON array to exactly N trimmed strings', () => {
    const raw = '["  panel one ", "panel two", "panel three", "panel four"]';
    expect(parsePanelFillResponse(raw, 4)).toEqual([
      'panel one',
      'panel two',
      'panel three',
      'panel four',
    ]);
  });

  it('parses a ```json fenced array', () => {
    const raw = 'Here you go:\n```json\n["a", "b", "c", "d"]\n```\nDone.';
    expect(parsePanelFillResponse(raw, 4)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pads with empty strings when the model returns too few', () => {
    expect(parsePanelFillResponse('["a", "b"]', 4)).toEqual(['a', 'b', '', '']);
  });

  it('truncates when the model returns too many', () => {
    expect(parsePanelFillResponse('["a", "b", "c", "d", "e", "f"]', 4)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('preserves index alignment — an interior non-string becomes a blank, not a shift', () => {
    // Panel 2 is null; the result must keep "c" at index 2, not slide it up.
    expect(parsePanelFillResponse('["a", null, "c", "d"]', 4)).toEqual(['a', '', 'c', 'd']);
  });

  it('throws when there is no JSON array to extract', () => {
    expect(() => parsePanelFillResponse('I cannot help with that.', 4)).toThrow();
  });

  it('throws when the JSON is an object rather than an array', () => {
    expect(() => parsePanelFillResponse('{"panels": ["a"]}', 4)).toThrow(
      /array of panel prompts/i,
    );
  });
});
