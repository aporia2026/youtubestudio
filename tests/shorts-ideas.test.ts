import { describe, expect, it } from 'vitest';
import {
  HOOK_STYLES,
  POVS,
  TONES,
  buildDoctrineBlock,
  buildInspirationBlock,
  buildNicheContextBlock,
  buildSeriesBlock,
  buildShortsIdeasPrompt,
  clampCount,
  clampTargetLength,
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

describe('Phase 15.8 — clampTargetLength', () => {
  it('returns undefined for non-finite / non-numeric input', () => {
    expect(clampTargetLength(undefined)).toBeUndefined();
    expect(clampTargetLength(NaN)).toBeUndefined();
    expect(clampTargetLength(Infinity)).toBeUndefined();
  });

  it('clamps into [15, 90]', () => {
    expect(clampTargetLength(5)).toBe(15);
    expect(clampTargetLength(15)).toBe(15);
    expect(clampTargetLength(45)).toBe(45);
    expect(clampTargetLength(90)).toBe(90);
    expect(clampTargetLength(500)).toBe(90);
  });

  it('rounds floats', () => {
    expect(clampTargetLength(45.4)).toBe(45);
    expect(clampTargetLength(45.6)).toBe(46);
  });
});

describe('Phase 15.8 — buildDoctrineBlock', () => {
  it('returns empty string when no hints supplied', () => {
    expect(buildDoctrineBlock({})).toBe('');
  });

  it('emits a target-length line when supplied', () => {
    expect(buildDoctrineBlock({ targetLengthSec: 45 })).toMatch(/~45 seconds/);
  });

  it('clamps out-of-range targetLengthSec via clampTargetLength', () => {
    expect(buildDoctrineBlock({ targetLengthSec: 999 })).toMatch(/~90 seconds/);
  });

  it('emits a hook-style hint matching the chosen archetype', () => {
    for (const style of HOOK_STYLES) {
      const out = buildDoctrineBlock({ hookStyle: style });
      expect(out, style).toContain('DOCTRINE');
      expect(out.length).toBeGreaterThan(20);
    }
  });

  it('emits one bullet per supplied dimension', () => {
    const out = buildDoctrineBlock({
      targetLengthSec: 30,
      hookStyle: 'contrarian',
      tone: 'irreverent',
      pov: 'second-person',
    });
    // Four bullets — count "- " prefix occurrences.
    const bulletCount = (out.match(/\n- /g) ?? []).length;
    expect(bulletCount).toBe(4);
  });

  it('every TONE has a doctrine hint', () => {
    for (const t of TONES) {
      expect(buildDoctrineBlock({ tone: t })).toContain('DOCTRINE');
    }
  });

  it('every POV has a doctrine hint', () => {
    for (const p of POVS) {
      expect(buildDoctrineBlock({ pov: p })).toContain('DOCTRINE');
    }
  });
});

describe('Phase 15.8 — buildNicheContextBlock', () => {
  it('returns empty when no context supplied', () => {
    expect(buildNicheContextBlock(undefined)).toBe('');
    expect(buildNicheContextBlock({})).toBe('');
    expect(buildNicheContextBlock({ description: '', keywords: [] })).toBe('');
  });

  it('includes the description when supplied', () => {
    const out = buildNicheContextBlock({ description: 'About AI tools for solo devs.' });
    expect(out).toContain('Niche description');
    expect(out).toContain('About AI tools for solo devs.');
  });

  it('includes keywords when supplied', () => {
    const out = buildNicheContextBlock({ keywords: ['ai', 'solo', 'devs'] });
    expect(out).toContain('Niche keywords');
    expect(out).toContain('ai, solo, devs');
  });

  it('drops non-string keywords defensively', () => {
    // @ts-expect-error — runtime test for the defensive filter
    const out = buildNicheContextBlock({ keywords: ['valid', null, 42, 'also-valid'] });
    expect(out).toContain('valid');
    expect(out).toContain('also-valid');
    expect(out).not.toContain('null');
    expect(out).not.toContain('42');
  });

  it('truncates very long descriptions to keep prompt budget bounded', () => {
    const huge = 'a'.repeat(5000);
    const out = buildNicheContextBlock({ description: huge });
    expect(out.length).toBeLessThan(1500);
  });

  it('caps keyword list at 30 entries', () => {
    const lots = Array.from({ length: 50 }, (_, i) => `kw${i}`);
    const out = buildNicheContextBlock({ keywords: lots });
    expect(out).toContain('kw0');
    expect(out).toContain('kw29');
    expect(out).not.toContain('kw30');
  });
});

describe('Phase 15.8 — buildSeriesBlock', () => {
  it('returns empty when neither intro nor outro supplied', () => {
    expect(buildSeriesBlock(undefined, undefined)).toBe('');
    expect(buildSeriesBlock('', '')).toBe('');
    expect(buildSeriesBlock('   ', '   ')).toBe('');
  });

  it('emits intro when supplied', () => {
    const out = buildSeriesBlock('Welcome to Monday Doodle Facts.');
    expect(out).toContain('SERIES CONTEXT');
    expect(out).toContain('Welcome to Monday Doodle Facts.');
  });

  it('emits outro when supplied', () => {
    const out = buildSeriesBlock(undefined, 'See you next Monday.');
    expect(out).toContain('See you next Monday.');
  });

  it('reminds the model that hook still stands alone', () => {
    const out = buildSeriesBlock('intro', 'outro');
    expect(out).toMatch(/Hook should still stand alone/);
  });
});

describe('Phase 15.8 — buildInspirationBlock', () => {
  it('returns empty when both lists empty', () => {
    expect(buildInspirationBlock(undefined, undefined)).toBe('');
    expect(buildInspirationBlock([], [])).toBe('');
  });

  it('emits INSPIRED BY block with the supplied titles', () => {
    const out = buildInspirationBlock(['A great title', 'Another one'], undefined);
    expect(out).toContain('INSPIRED BY');
    expect(out).toContain('A great title');
    expect(out).toContain('Another one');
  });

  it('emits AVOID block with the supplied titles', () => {
    const out = buildInspirationBlock(undefined, ['Already covered']);
    expect(out).toContain('AVOID');
    expect(out).toContain('Already covered');
  });

  it('caps inspired list at 8 titles', () => {
    const lots = Array.from({ length: 20 }, (_, i) => `title-${i}`);
    const out = buildInspirationBlock(lots, undefined);
    expect(out).toContain('title-0');
    expect(out).toContain('title-7');
    expect(out).not.toContain('title-8');
  });

  it('caps avoid list at 20 titles', () => {
    const lots = Array.from({ length: 50 }, (_, i) => `recent-${i}`);
    const out = buildInspirationBlock(undefined, lots);
    expect(out).toContain('recent-0');
    expect(out).toContain('recent-19');
    expect(out).not.toContain('recent-20');
  });

  it('drops non-string entries defensively', () => {
    // @ts-expect-error — runtime test
    const out = buildInspirationBlock(['valid', null, 42, undefined], []);
    expect(out).toContain('valid');
    expect(out).not.toContain('null');
  });
});

describe('Phase 15.8 — buildShortsIdeasPrompt integration', () => {
  it('user prompt embeds the niche context block when nicheContext is supplied', () => {
    const { user } = buildShortsIdeasPrompt({
      niche: 'beekeeping',
      nicheContext: {
        description: 'Honey bees and urban hives.',
        keywords: ['urban', 'honey', 'queen'],
      },
    });
    expect(user).toContain('Niche description: Honey bees and urban hives.');
    expect(user).toContain('Niche keywords: urban, honey, queen');
  });

  it('user prompt embeds series intro/outro when supplied', () => {
    const { user } = buildShortsIdeasPrompt({
      niche: 'x',
      seriesIntro: 'Welcome to Monday Doodle Facts.',
      seriesOutro: 'See you next Monday.',
    });
    expect(user).toContain('SERIES CONTEXT');
    expect(user).toContain('Welcome to Monday Doodle Facts.');
    expect(user).toContain('See you next Monday.');
  });

  it('user prompt embeds inspired-by + avoid lists', () => {
    const { user } = buildShortsIdeasPrompt({
      niche: 'x',
      inspiredByTitles: ['Big Hit Short 1', 'Another Big Hit'],
      avoidTitles: ['Already Covered Topic'],
    });
    expect(user).toContain('INSPIRED BY');
    expect(user).toContain('Big Hit Short 1');
    expect(user).toContain('AVOID');
    expect(user).toContain('Already Covered Topic');
  });

  it('system prompt includes the doctrine block when format hints supplied', () => {
    const { system } = buildShortsIdeasPrompt({
      niche: 'x',
      formatHints: { targetLengthSec: 30, hookStyle: 'contrarian' },
    });
    expect(system).toContain('DOCTRINE');
    expect(system).toContain('~30 seconds');
    expect(system).toContain('contrarian');
  });

  it('still works in the legacy { niche, context, count } shape', () => {
    const { system, user } = buildShortsIdeasPrompt({
      niche: 'legacy niche',
      context: 'legacy context',
      count: 5,
    });
    expect(system).toMatch(/5 hook-first/);
    expect(user).toContain('legacy niche');
    expect(user).toContain('legacy context');
  });
});
