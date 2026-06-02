import { describe, expect, it } from 'vitest';
import { scoreHook } from '@/lib/hook-scoring';

/**
 * Hook scoring is heuristic, so tests assert RELATIVE ordering
 * (strong > weak > boilerplate) and BOUNDARIES (clamp, length caps),
 * not absolute scores. Absolute thresholds would force test rewrites
 * every time we tune a weight.
 */

describe('scoreHook — boundaries', () => {
  it('returns 0 for empty / whitespace-only input', () => {
    expect(scoreHook('').score).toBe(0);
    expect(scoreHook('   ').score).toBe(0);
    expect(scoreHook('\n\t').score).toBe(0);
  });

  it('caps under-3-word openings at 0.3', () => {
    expect(scoreHook('hi there').score).toBe(0.3);
    expect(scoreHook('go').score).toBe(0.3);
  });

  it('soft-caps overly long openings at 0.6', () => {
    // 21 words of strong-hook content — would otherwise score >0.6.
    const longHook =
      'why do you never see this secret truth that nobody talks about exactly when you actually need to know it now';
    expect(scoreHook(longHook).score).toBeLessThanOrEqual(0.6);
  });

  it('clamps the final score into [0, 1]', () => {
    // All penalties stacked.
    const trash = "hey guys today let's talk about something boring and forgettable";
    const r = scoreHook(trash);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('scoreHook — strong hooks beat weak ones', () => {
  it('question-mark opener beats neutral', () => {
    const q = scoreHook('Why do most people fail at this?').score;
    const n = scoreHook('Most people fail at this thing').score;
    expect(q).toBeGreaterThan(n);
  });

  it('numeric specificity beats vague', () => {
    const specific = scoreHook('Three reasons your shorts are flopping').score;
    const vague = scoreHook('A few reasons your shorts are flopping').score;
    expect(specific).toBeGreaterThan(vague);
  });

  it('second-person address beats third-person', () => {
    const you = scoreHook('You are doing this completely wrong').score;
    const they = scoreHook('Many creators are doing this completely wrong').score;
    expect(you).toBeGreaterThan(they);
  });

  it('counter-intuitive negation lifts the score', () => {
    const neg = scoreHook('Never use a hook like this').score;
    const plain = scoreHook('Always think about your opening line').score;
    expect(neg).toBeGreaterThan(plain);
  });
});

describe('scoreHook — weak openers get penalized', () => {
  it('filler opener "today" drops the score', () => {
    const filler = scoreHook("today we're going to talk about hooks").score;
    const direct = scoreHook("most hooks are too long to land").score;
    expect(filler).toBeLessThan(direct);
  });

  it('channel boilerplate "hey guys" gets a strong penalty', () => {
    const boiler = scoreHook('hey guys welcome back to the channel').score;
    const neutral = scoreHook('welcome to a short explanation of hooks').score;
    expect(boiler).toBeLessThan(neutral);
  });

  it('"let\'s" opener softer than filler but still weak', () => {
    const lets = scoreHook("let's look at three hooks that work").score;
    const direct = scoreHook("three hooks that work on the first frame").score;
    expect(lets).toBeLessThan(direct);
  });
});

describe('scoreHook — reasons explain the score', () => {
  it('lists strong-signal reasons for strong hooks', () => {
    const r = scoreHook('You have 3 seconds — why are you wasting them?');
    expect(r.reasons.some((s) => s.includes('question'))).toBe(true);
    expect(r.reasons.some((s) => s.includes('number'))).toBe(true);
    expect(r.reasons.some((s) => s.includes('second-person'))).toBe(true);
  });

  it('lists weak-signal reasons for weak hooks', () => {
    const r = scoreHook("hey guys today we're going to look at something");
    const text = r.reasons.join(' ');
    expect(text.toLowerCase()).toMatch(/hey guys|boilerplate|filler|weak/);
  });

  it('explains the empty case explicitly', () => {
    expect(scoreHook('').reasons).toContain('empty input');
  });
});

describe('scoreHook — golden samples (known-strong / known-weak)', () => {
  const STRONG = [
    'Why did you never hear about this rule?',
    'Stop scrolling — you need to see this.',
    'Three mistakes every creator makes in the first second.',
    "You're wrong about hooks. Here's the truth.",
    'Nobody tells you this about shorts.',
  ];

  const WEAK = [
    "Hey guys, welcome back to the channel!",
    "Today we're going to be talking about a few things.",
    "So basically, like, let's think about this for a second.",
    "Um, ok, hi, in this video we'll cover stuff.",
    "Welcome to my channel where we talk about things.",
  ];

  it('all known-strong hooks score above 0.55', () => {
    for (const h of STRONG) {
      const { score } = scoreHook(h);
      expect(score, `strong hook scored too low: "${h}"`).toBeGreaterThan(0.55);
    }
  });

  it('all known-weak hooks score below 0.45', () => {
    for (const h of WEAK) {
      const { score } = scoreHook(h);
      expect(score, `weak hook scored too high: "${h}"`).toBeLessThan(0.45);
    }
  });
});
