import { describe, expect, it } from 'vitest';
import {
  buildShortsIdeasPrompt,
  clampCount,
  parseShortsIdeas,
} from '@/lib/shorts-ideas';

describe('clampCount', () => {
  it('returns the default for non-numeric / non-finite input', () => {
    expect(clampCount(undefined)).toBe(8);
    expect(clampCount(NaN)).toBe(8);
    expect(clampCount(Infinity)).toBe(8);
  });

  it('clamps into [3, 15]', () => {
    expect(clampCount(0)).toBe(3);
    expect(clampCount(2)).toBe(3);
    expect(clampCount(8)).toBe(8);
    expect(clampCount(20)).toBe(15);
    expect(clampCount(-100)).toBe(3);
  });

  it('rounds floats to integers', () => {
    expect(clampCount(5.4)).toBe(5);
    expect(clampCount(5.6)).toBe(6);
  });
});

describe('buildShortsIdeasPrompt', () => {
  it('embeds the niche in the user message', () => {
    const { user } = buildShortsIdeasPrompt({ niche: 'beekeeping' });
    expect(user).toContain('beekeeping');
  });

  it('embeds the context when supplied', () => {
    const { user } = buildShortsIdeasPrompt({
      niche: 'beekeeping',
      context: 'Channel voice: dry, wry, technical.',
    });
    expect(user).toContain('dry, wry, technical');
  });

  it('asks for the requested count, clamped to [3, 15]', () => {
    const { system, user } = buildShortsIdeasPrompt({ niche: 'x', count: 100 });
    expect(system).toMatch(/15 hook-first/);
    expect(user).toMatch(/Generate 15/);
  });

  it('demands strict JSON output', () => {
    const { system } = buildShortsIdeasPrompt({ niche: 'x' });
    expect(system).toMatch(/JSON only|STRICTLY this JSON/);
  });

  it('lists the five hook-first guard-rails', () => {
    const { system } = buildShortsIdeasPrompt({ niche: 'x' });
    expect(system).toMatch(/HOOK line/);
    expect(system).toMatch(/≤60 seconds|60 second/);
    expect(system).toMatch(/9:16|vertical/);
    expect(system).toMatch(/payoff|PAYOFF/);
    expect(system).toMatch(/shelf/i);
  });

  it('includes the cliché blocklist', () => {
    const { system } = buildShortsIdeasPrompt({ niche: 'x' });
    expect(system).toContain('navigate');
    expect(system).toContain('hey guys');
  });
});

describe('parseShortsIdeas', () => {
  const valid = JSON.stringify({
    ideas: [
      {
        hook: "You're tying your shoes wrong.",
        title: 'The Granny Knot You Tied Today',
        payoff: 'Loop the second twist away. Done.',
        thesis: 'The default shoelace knot is structurally weaker than the alternative.',
        shotConcept: 'Close-up of shoelaces, two takes side by side.',
        confidence: 0.85,
      },
    ],
  });

  it('parses a well-formed response into typed ideas', () => {
    const r = parseShortsIdeas(valid);
    expect(r.length).toBe(1);
    expect(r[0]!.hook).toMatch(/shoes wrong/);
    expect(r[0]!.confidence).toBeCloseTo(0.85, 2);
  });

  it('tolerates fenced JSON', () => {
    const fenced = '```json\n' + valid + '\n```';
    expect(parseShortsIdeas(fenced).length).toBe(1);
  });

  it('accepts snake_case shot_concept alongside camelCase', () => {
    const snake = JSON.stringify({
      ideas: [{ hook: 'x', title: 'y', shot_concept: 'fixed' }],
    });
    expect(parseShortsIdeas(snake)[0]!.shotConcept).toBe('fixed');
  });

  it('skips rows missing hook or title', () => {
    const partial = JSON.stringify({
      ideas: [
        { hook: 'good', title: 'good' },
        { hook: 'no title' },
        { title: 'no hook' },
      ],
    });
    expect(parseShortsIdeas(partial).length).toBe(1);
  });

  it('clamps confidence into [0, 1] and defaults missing to 0.5', () => {
    const raw = JSON.stringify({
      ideas: [
        { hook: 'a', title: 'a', confidence: 99 },
        { hook: 'b', title: 'b', confidence: -1 },
        { hook: 'c', title: 'c' },
      ],
    });
    const r = parseShortsIdeas(raw);
    expect(r[0]!.confidence).toBe(1);
    expect(r[1]!.confidence).toBe(0);
    expect(r[2]!.confidence).toBe(0.5);
  });

  it('throws when the response has no ideas array', () => {
    expect(() => parseShortsIdeas('{}')).toThrow(/missing the "ideas" array/);
  });

  it('throws when every idea row is invalid', () => {
    const trash = JSON.stringify({ ideas: [{}, { foo: 'bar' }] });
    expect(() => parseShortsIdeas(trash)).toThrow(/No valid Shorts ideas/);
  });

  it('throws on unrecoverable input', () => {
    expect(() => parseShortsIdeas('nope')).toThrow(/Could not parse/);
  });
});
