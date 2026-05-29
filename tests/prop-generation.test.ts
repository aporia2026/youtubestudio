import { describe, expect, it } from 'vitest';
import {
  buildPropPrompt,
  generatePropImage,
  PROP_PROMPT_PREFIX,
  PROP_PROMPT_SUFFIX,
} from '@/lib/prop-generation';

// ─── buildPropPrompt ────────────────────────────────────────────────
//
// Pure string assembly — exported because the prompt is load-bearing
// for prop visual quality. Silent edits could degrade every
// prop_slide render without leaving a trace.

describe('buildPropPrompt', () => {
  it('wraps the hint with the canonical prefix + suffix', () => {
    const prompt = buildPropPrompt('a wooden barrel');
    expect(prompt.startsWith(PROP_PROMPT_PREFIX)).toBe(true);
    expect(prompt.endsWith(PROP_PROMPT_SUFFIX)).toBe(true);
    expect(prompt).toContain('a wooden barrel');
  });

  it("trims whitespace around the hint", () => {
    const prompt = buildPropPrompt('  a Polaroid SX-70  ');
    expect(prompt).toContain('A single hand-drawn doodle of a Polaroid SX-70');
    expect(prompt).not.toContain('  a Polaroid');
  });

  it("strips a trailing period from the hint to avoid double-periods at the suffix boundary", () => {
    const prompt = buildPropPrompt('a rolled-up parchment scroll.');
    expect(prompt).not.toContain('scroll..');
    expect(prompt).toContain('a rolled-up parchment scroll on');
  });

  it('strips multiple trailing periods', () => {
    const prompt = buildPropPrompt('a wooden barrel...');
    expect(prompt).not.toContain('barrel..');
    expect(prompt).toContain('a wooden barrel on');
  });
});

describe('PROP_PROMPT_SUFFIX — load-bearing directives', () => {
  it('asks for a single hand-drawn doodle', () => {
    expect(PROP_PROMPT_PREFIX).toMatch(/hand-drawn doodle/i);
  });

  it('demands a pure white background', () => {
    expect(PROP_PROMPT_SUFFIX).toMatch(/white background/i);
  });

  it('forbids text / labels / shadow', () => {
    expect(PROP_PROMPT_SUFFIX).toMatch(/no text/i);
    expect(PROP_PROMPT_SUFFIX).toMatch(/no shadow/i);
  });

  it('forbids a character or scene', () => {
    expect(PROP_PROMPT_SUFFIX).toMatch(/no character/i);
    expect(PROP_PROMPT_SUFFIX).toMatch(/no scene/i);
  });

  it('demands centered framing with negative space', () => {
    expect(PROP_PROMPT_SUFFIX).toMatch(/centered/i);
    expect(PROP_PROMPT_SUFFIX).toMatch(/negative space/i);
  });

  it('fits within a reasonable prompt budget', () => {
    const full = buildPropPrompt('a generic prop');
    expect(full.length).toBeGreaterThan(150);
    expect(full.length).toBeLessThan(1500);
  });
});

// ─── generatePropImage — input validation ────────────────────────────
//
// The happy path requires an Atlas T2I call we don't want to fire
// from a unit test. Input-validation paths bail before the Atlas call
// and are safe to exercise here.

describe('generatePropImage (input validation)', () => {
  it("returns { error: 'empty_prompt_hint' } for an empty hint", async () => {
    const result = await generatePropImage({ promptHint: '' });
    expect('error' in result && result.error).toBe('empty_prompt_hint');
    expect(result.costUsd).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns { error: 'empty_prompt_hint' } for a whitespace-only hint", async () => {
    const result = await generatePropImage({ promptHint: '   \t\n  ' });
    expect('error' in result && result.error).toBe('empty_prompt_hint');
    expect(result.costUsd).toBe(0);
  });

  it('reports a non-negative durationMs on validation failure', async () => {
    const result = await generatePropImage({ promptHint: '' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
