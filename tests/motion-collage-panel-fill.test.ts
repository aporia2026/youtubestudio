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
