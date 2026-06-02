import { describe, expect, it } from 'vitest';
import {
  assembleQaResult,
  buildShortsQaPrompt,
  composeQaScore,
  parseShortsQa,
  takeHookSlice,
} from '@/lib/shorts-qa';

describe('takeHookSlice', () => {
  it('returns the first 4 words for a short script', () => {
    expect(takeHookSlice('You have three seconds to win this swipe')).toBe(
      'You have three seconds',
    );
  });

  it('strips bracketed production markers', () => {
    expect(takeHookSlice('[VISUAL: phone] Stop scrolling and watch this now')).toBe(
      'Stop scrolling and watch',
    );
  });

  it('returns empty string for empty input', () => {
    expect(takeHookSlice('')).toBe('');
  });

  it('caps at 4 words (≈1.5s of speech at the 2.33 wps cadence)', () => {
    const long = Array(30).fill('word').join(' ');
    expect(takeHookSlice(long).split(/\s+/).length).toBeLessThanOrEqual(4);
  });

  it('returns fewer than 4 words when the script is shorter', () => {
    expect(takeHookSlice('Stop.').split(/\s+/).length).toBe(1);
    expect(takeHookSlice('Stop scrolling.').split(/\s+/).length).toBe(2);
  });
});

describe('composeQaScore', () => {
  it('returns 0 when every component is 0', () => {
    expect(
      composeQaScore({
        hookStrength: 0,
        threeSecondRule: 0,
        payoffClarity: 0,
        captionReadable: 0,
        loopPotential: 0,
        verticalSafeZone: 0,
      }),
    ).toBe(0);
  });

  it('returns 1 when every component is 1', () => {
    expect(
      composeQaScore({
        hookStrength: 1,
        threeSecondRule: 1,
        payoffClarity: 1,
        captionReadable: 1,
        loopPotential: 1,
        verticalSafeZone: 1,
      }),
    ).toBe(1);
  });

  it('hook weight (0.3) dominates over individual lesser criteria', () => {
    const hookOnly = composeQaScore({
      hookStrength: 1,
      threeSecondRule: 0,
      payoffClarity: 0,
      captionReadable: 0,
      loopPotential: 0,
      verticalSafeZone: 0,
    });
    const captionOnly = composeQaScore({
      hookStrength: 0,
      threeSecondRule: 0,
      payoffClarity: 0,
      captionReadable: 1,
      loopPotential: 0,
      verticalSafeZone: 0,
    });
    expect(hookOnly).toBeGreaterThan(captionOnly);
    expect(hookOnly).toBeCloseTo(0.3, 5);
  });

  it('clamps out-of-range inputs', () => {
    const result = composeQaScore({
      hookStrength: 999,
      threeSecondRule: -10,
      payoffClarity: 0.5,
      captionReadable: NaN,
      loopPotential: Infinity,
      verticalSafeZone: 0.5,
    });
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe('buildShortsQaPrompt', () => {
  it('embeds the script in the user message', () => {
    const { user } = buildShortsQaPrompt({
      scriptText: 'Stop scrolling. Three reasons your hook is broken.',
    });
    expect(user).toContain('Stop scrolling');
  });

  it('demands strict JSON output', () => {
    const { system } = buildShortsQaPrompt({ scriptText: 'x' });
    expect(system).toMatch(/STRICT JSON|JSON only/);
  });

  it('lists every of the five AI-graded criteria', () => {
    const { system } = buildShortsQaPrompt({ scriptText: 'x' });
    for (const k of [
      'three_second_rule',
      'payoff_clarity',
      'caption_readable',
      'loop_potential',
      'vertical_safe_zone',
    ]) {
      expect(system).toContain(k);
    }
  });

  it('asks for three concrete fixes', () => {
    const { system } = buildShortsQaPrompt({ scriptText: 'x' });
    expect(system).toMatch(/THREE concrete fixes/);
  });
});

describe('parseShortsQa', () => {
  const valid = JSON.stringify({
    three_second_rule: { score: 0.8, reason: 'line 2 lands' },
    payoff_clarity: { score: 0.7, reason: 'clear reframe' },
    caption_readable: { score: 0.9, reason: 'short fragments' },
    loop_potential: { score: 0.5, reason: 'no loop intent' },
    vertical_safe_zone: { score: 0.95, reason: 'arc fits 50s' },
    fixes: ['rewrite line 5 as a question', 'cut the meta intro', 'tighten line 8'],
  });

  it('parses a well-formed response into typed criteria', () => {
    const r = parseShortsQa(valid);
    expect(r.threeSecondRule.score).toBeCloseTo(0.8, 2);
    expect(r.payoffClarity.reason).toBe('clear reframe');
    expect(r.fixes.length).toBe(3);
  });

  it('handles fenced JSON', () => {
    const fenced = '```json\n' + valid + '\n```';
    expect(() => parseShortsQa(fenced)).not.toThrow();
  });

  it('defaults missing criteria to 0.5 with a fallback reason', () => {
    const partial = JSON.stringify({
      three_second_rule: { score: 0.8, reason: 'ok' },
      fixes: [],
    });
    const r = parseShortsQa(partial);
    expect(r.payoffClarity.score).toBe(0.5);
    expect(r.payoffClarity.reason).toMatch(/payoff/i);
  });

  it('clamps malformed scores into [0, 1]', () => {
    const wild = JSON.stringify({
      three_second_rule: { score: 999, reason: 'x' },
      payoff_clarity: { score: -5, reason: 'x' },
      caption_readable: { score: 'high', reason: 'x' },
      loop_potential: { score: NaN, reason: 'x' },
      vertical_safe_zone: { score: 0.5, reason: 'x' },
      fixes: ['a'],
    });
    const r = parseShortsQa(wild);
    expect(r.threeSecondRule.score).toBe(1);
    expect(r.payoffClarity.score).toBe(0);
    expect(r.captionReadable.score).toBe(0.5); // non-number → default
    expect(r.loopPotential.score).toBe(0.5); // NaN → default
  });

  it('throws on completely unrecoverable input', () => {
    expect(() => parseShortsQa('nope, not json')).toThrow(/Could not parse/);
  });

  it('caps fixes at 5 items', () => {
    const many = JSON.stringify({
      three_second_rule: { score: 0.5, reason: 'x' },
      payoff_clarity: { score: 0.5, reason: 'x' },
      caption_readable: { score: 0.5, reason: 'x' },
      loop_potential: { score: 0.5, reason: 'x' },
      vertical_safe_zone: { score: 0.5, reason: 'x' },
      fixes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(parseShortsQa(many).fixes.length).toBeLessThanOrEqual(5);
  });
});

describe('assembleQaResult', () => {
  it('computes hookStrength deterministically + composes the composite', () => {
    const parsed = parseShortsQa(JSON.stringify({
      three_second_rule: { score: 0.8, reason: '.' },
      payoff_clarity: { score: 0.8, reason: '.' },
      caption_readable: { score: 0.8, reason: '.' },
      loop_potential: { score: 0.8, reason: '.' },
      vertical_safe_zone: { score: 0.8, reason: '.' },
      fixes: ['x'],
    }));
    const result = assembleQaResult(
      { scriptText: 'Why do most Shorts fail in the first second?' },
      parsed,
    );
    // Strong-hook + 0.8 across the board → composite should be high.
    expect(result.composite).toBeGreaterThan(0.7);
    // Hook strength comes from the deterministic scorer (Phase 1).
    expect(result.hookStrength.score).toBeGreaterThan(0.5);
  });

  it('weak hook drags the composite down even with high AI scores', () => {
    const parsed = parseShortsQa(JSON.stringify({
      three_second_rule: { score: 1, reason: '.' },
      payoff_clarity: { score: 1, reason: '.' },
      caption_readable: { score: 1, reason: '.' },
      loop_potential: { score: 1, reason: '.' },
      vertical_safe_zone: { score: 1, reason: '.' },
      fixes: ['x'],
    }));
    const result = assembleQaResult(
      { scriptText: 'hey guys welcome back to the channel today' },
      parsed,
    );
    // 70% from AI (all 1) + 30% from hook (≤0.45 for boilerplate) → < 0.9
    expect(result.composite).toBeLessThan(0.9);
    expect(result.hookStrength.score).toBeLessThan(0.5);
  });
});
