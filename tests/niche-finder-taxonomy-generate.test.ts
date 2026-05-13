/**
 * Pure-helper tests for the niche-taxonomy AI output parser.
 *
 * The parser has to survive five real-world failure modes seen during
 * development:
 *   1. Models wrap the JSON in ```json ``` fences.
 *   2. Models preface the JSON with prose ("Here's the list:").
 *   3. Models duplicate names across the response.
 *   4. Models repeat names that already exist in the parent's children.
 *   5. Models emit empty / unparseable / completely missing JSON.
 *
 * Every branch is exercised below. The parser is provider-agnostic by
 * design (no model-specific tricks) so the same code path runs for
 * Anthropic / OpenAI / Gemini / Kie / Perplexity output.
 */
import { describe, expect, it } from 'vitest';
import { parseTaxonomyOutput } from '@/lib/niche-finder/taxonomy-generate';

describe('parseTaxonomyOutput', () => {
  it('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      children: [
        { name: 'long-term rental analysis', rationale: 'cash-flow analysis is searchable' },
        { name: 'house hacking with multifamily', rationale: 'beginner-friendly entry path' },
      ],
    });
    const out = parseTaxonomyOutput(raw, []);
    expect(out.map((c) => c.name)).toEqual([
      'long-term rental analysis',
      'house hacking with multifamily',
    ]);
    expect(out[0].slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({ children: [{ name: 'tax loss harvesting' }] }) + '\n```';
    const out = parseTaxonomyOutput(raw, []);
    expect(out.map((c) => c.name)).toEqual(['tax loss harvesting']);
  });

  it('strips preamble prose before the JSON', () => {
    const raw =
      'Here are some monetization-tilted ideas:\n\n' +
      JSON.stringify({ children: [{ name: 'real estate investing' }] }) +
      '\n\nLet me know if you want more!';
    const out = parseTaxonomyOutput(raw, []);
    expect(out.map((c) => c.name)).toEqual(['real estate investing']);
  });

  it('dedupes against existing-child names case-insensitively', () => {
    const raw = JSON.stringify({
      children: [
        { name: 'Stock Market For Beginners' }, // dup, case-different
        { name: 'crypto trading explained' },
      ],
    });
    const out = parseTaxonomyOutput(raw, ['stock market for beginners']);
    expect(out.map((c) => c.name)).toEqual(['crypto trading explained']);
  });

  it('dedupes duplicates within the response', () => {
    const raw = JSON.stringify({
      children: [
        { name: 'retirement planning explained' },
        { name: 'Retirement planning explained' },
        { name: 'retirement planning explained' },
      ],
    });
    const out = parseTaxonomyOutput(raw, []);
    expect(out.length).toBe(1);
  });

  it('returns empty array for completely malformed input', () => {
    expect(parseTaxonomyOutput('not json at all', [])).toEqual([]);
    expect(parseTaxonomyOutput('', [])).toEqual([]);
    expect(parseTaxonomyOutput('{}', [])).toEqual([]);
    expect(parseTaxonomyOutput('{"children":"not an array"}', [])).toEqual([]);
  });

  it('skips items missing a name', () => {
    const raw = JSON.stringify({
      children: [
        { name: 'good name' },
        { name: '' },
        { rationale: 'no name field' },
        { name: '   ' },
      ],
    });
    const out = parseTaxonomyOutput(raw, []);
    expect(out.map((c) => c.name)).toEqual(['good name']);
  });

  it('caps name length at 80 chars', () => {
    const longName = 'super long name '.repeat(20);
    const raw = JSON.stringify({ children: [{ name: longName }] });
    const out = parseTaxonomyOutput(raw, []);
    expect(out[0].name.length).toBeLessThanOrEqual(80);
  });

  it('caps rationale length at 200 chars and trims whitespace', () => {
    const longRationale = 'why this matters '.repeat(50);
    const raw = JSON.stringify({
      children: [{ name: 'sample', rationale: `   ${longRationale}   ` }],
    });
    const out = parseTaxonomyOutput(raw, []);
    expect(out[0].rationale.length).toBeLessThanOrEqual(200);
    expect(out[0].rationale.startsWith(' ')).toBe(false);
  });

  it('produces non-empty kebab-case slugs', () => {
    const raw = JSON.stringify({
      children: [
        { name: 'AI Tools, Reviewed: 2026 Edition' },
        { name: 'NBA Stats Deep-Dive' },
      ],
    });
    const out = parseTaxonomyOutput(raw, []);
    for (const c of out) {
      expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      expect(c.slug.length).toBeGreaterThan(0);
    }
  });

  it('caps response at 50 entries', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ name: `niche number ${i}` }));
    const raw = JSON.stringify({ children: items });
    const out = parseTaxonomyOutput(raw, []);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it('handles non-string input gracefully', () => {
    // The type signature is `string`, but production code can hand us
    // `null` from a buggy upstream (we cast through `unknown`). Test
    // with a force-cast to confirm we don't throw.
    expect(parseTaxonomyOutput(null as unknown as string, [])).toEqual([]);
    expect(parseTaxonomyOutput(123 as unknown as string, [])).toEqual([]);
  });

  it('treats missing rationale as empty string, not undefined', () => {
    const raw = JSON.stringify({ children: [{ name: 'only-name' }] });
    const out = parseTaxonomyOutput(raw, []);
    expect(out[0].rationale).toBe('');
  });

  it('produces unique slugs across the response', () => {
    // Two different names that slugify the same shouldn't both survive.
    const raw = JSON.stringify({
      children: [
        { name: 'AI Tools' },
        { name: 'AI tools' }, // same slug after lowercase
        { name: 'ai-tools' },
      ],
    });
    const out = parseTaxonomyOutput(raw, []);
    const slugs = out.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
