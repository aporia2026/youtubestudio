import { describe, expect, it } from 'vitest';
import {
  AI_PRICING_REGISTRY,
  computeCost,
  findPricing,
} from '@/lib/ai-pricing';

describe('findPricing', () => {
  it('finds Anthropic models by prefix', () => {
    const haiku = findPricing('claude-haiku-4-5-20251001');
    expect(haiku).not.toBeNull();
    expect(haiku!.provider).toBe('anthropic');
    expect(haiku!.label).toBe('Claude Haiku 4.5');
  });

  it('finds Sonnet vs Opus correctly (no overlap)', () => {
    expect(findPricing('claude-sonnet-4-6')!.label).toBe('Claude Sonnet 4.6');
    expect(findPricing('claude-opus-4-7')!.label).toBe('Claude Opus 4.7');
    expect(findPricing('claude-opus-4-7-20251015')!.label).toBe('Claude Opus 4.7');
  });

  it('finds OpenAI families', () => {
    expect(findPricing('gpt-5-nano')!.provider).toBe('openai');
    expect(findPricing('gpt-5-mini-20250101')!.label).toBe('GPT-5 Mini');
    expect(findPricing('gpt-4o-2024-11-20')!.label).toBe('GPT-4o');
  });

  it('finds the Kie Gemini route exactly', () => {
    const k = findPricing('kie-gemini-3.1-pro');
    expect(k).not.toBeNull();
    expect(k!.provider).toBe('kie');
  });

  it('returns null for unknown / blank model ids', () => {
    expect(findPricing('made-up-model-9000')).toBeNull();
    expect(findPricing('')).toBeNull();
  });

  it('exact matches take precedence over prefix matches', () => {
    // gpt-5 prefix would normally match "gpt-5-nano" first if the
    // registry weren't ordered correctly. Verify nano resolves to its
    // own entry, not the broader gpt-5 entry.
    const nano = findPricing('gpt-5-nano');
    expect(nano!.label).toBe('GPT-5 Nano');
    expect(nano!.label).not.toBe('GPT-5');
  });
});

describe('computeCost', () => {
  it('zeros + provider="unknown" for an unrecognized model', () => {
    const c = computeCost('made-up', 1000, 500);
    expect(c.cost_usd_total).toBe(0);
    expect(c.provider).toBe('unknown');
    expect(c.applied_pricing).toBeNull();
  });

  it('Sonnet 4.6: 1M input + 1M output = $3 + $15 = $18', () => {
    const c = computeCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(c.cost_usd_input).toBeCloseTo(3.0, 4);
    expect(c.cost_usd_output).toBeCloseTo(15.0, 4);
    expect(c.cost_usd_total).toBeCloseTo(18.0, 4);
    expect(c.provider).toBe('anthropic');
  });

  it('Haiku 4.5: 1M input + 1M output = $1 + $5 = $6', () => {
    const c = computeCost('claude-haiku-4-5', 1_000_000, 1_000_000);
    expect(c.cost_usd_total).toBeCloseTo(6.0, 4);
  });

  it('Opus 4.7: 100K in + 50K out = $1.5 + $3.75 = $5.25', () => {
    const c = computeCost('claude-opus-4-7', 100_000, 50_000);
    expect(c.cost_usd_input).toBeCloseTo(1.5, 4);
    expect(c.cost_usd_output).toBeCloseTo(3.75, 4);
    expect(c.cost_usd_total).toBeCloseTo(5.25, 4);
  });

  it('cached input is billed at the discounted rate', () => {
    // Sonnet: 1M total input where 800K is cached.
    // Billable input: 200K * $3/M = $0.60
    // Cached input: 800K * $0.30/M = $0.24
    // Total input cost: $0.84 (vs $3.00 if all were billable)
    const c = computeCost('claude-sonnet-4-6', 1_000_000, 0, 800_000);
    expect(c.cost_usd_input).toBeCloseTo(0.84, 4);
    expect(c.cost_usd_total).toBeCloseTo(0.84, 4);
  });

  it('handles zero tokens cleanly', () => {
    const c = computeCost('claude-sonnet-4-6', 0, 0);
    expect(c.cost_usd_total).toBe(0);
  });

  it('cached count exceeding total input is clamped, not negative', () => {
    // Defensive: if a buggy SDK reports cached_input_tokens > input_tokens,
    // billable input clamps to 0 (not a negative refund).
    const c = computeCost('claude-sonnet-4-6', 100, 0, 500);
    expect(c.cost_usd_input).toBeGreaterThanOrEqual(0);
  });

  it('rounds to 6 decimals (sub-cent precision)', () => {
    const c = computeCost('claude-haiku-4-5', 1, 1);
    // 1 token in = $1/1M = $0.000001 — must round to 6 places, not zero
    expect(c.cost_usd_input).toBe(0.000001);
    expect(c.cost_usd_output).toBe(0.000005);
  });
});

describe('AI_PRICING_REGISTRY', () => {
  it('every entry has positive rates', () => {
    for (const e of AI_PRICING_REGISTRY) {
      expect(e.inputPerMillion).toBeGreaterThan(0);
      expect(e.outputPerMillion).toBeGreaterThan(0);
      // Output is usually more expensive than input for chat models.
      expect(e.outputPerMillion).toBeGreaterThanOrEqual(e.inputPerMillion);
    }
  });

  it('every entry has a non-empty label', () => {
    for (const e of AI_PRICING_REGISTRY) {
      expect(e.label.length).toBeGreaterThan(2);
    }
  });

  it('cached input rate is always cheaper than full input rate when set', () => {
    for (const e of AI_PRICING_REGISTRY) {
      if (e.cachedInputPerMillion !== undefined) {
        expect(e.cachedInputPerMillion).toBeLessThan(e.inputPerMillion);
      }
    }
  });
});
