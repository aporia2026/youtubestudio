import { describe, it, expect } from 'vitest';
import { extractJson } from '../src/lib/auto-pipeline/stages/generate-production-doc';

/**
 * Production-doc JSON extraction — the hardened parser introduced
 * 2026-05-27 after a `Cyber Explainer Batch` run hit
 * `empty_or_malformed` on a prose-wrapped model response. The naive
 * `JSON.parse(body.trim())` path couldn't recover; this helper does.
 */
describe('extractJson', () => {
  it('returns null for empty input', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('   \n  \n')).toBeNull();
  });

  it('parses plain JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses plain JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const text = '```json\n{"rows": []}\n```';
    expect(extractJson(text)).toEqual({ rows: [] });
  });

  it('strips bare ``` fences', () => {
    const text = '```\n{"rows": []}\n```';
    expect(extractJson(text)).toEqual({ rows: [] });
  });

  it('recovers from prose preamble before the JSON', () => {
    const text = `Here's the production doc you asked for:\n\n{"rows": [{"id": "r1"}]}`;
    expect(extractJson(text)).toEqual({ rows: [{ id: 'r1' }] });
  });

  it('recovers from prose postamble after the JSON', () => {
    const text = `{"rows": [{"id": "r1"}]}\n\nLet me know if you need anything else.`;
    expect(extractJson(text)).toEqual({ rows: [{ id: 'r1' }] });
  });

  it('recovers from prose on BOTH sides of the JSON', () => {
    const text = `Sure! Here is the doc:\n\n{"a": 1, "b": [1,2,3]}\n\nHappy to revise.`;
    expect(extractJson(text)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('handles nested objects + arrays + strings with braces', () => {
    const obj = {
      rows: [
        { id: 'a', script_text: 'He said: "{ not JSON }" — got it?' },
        { id: 'b', children: [{ nested: { deep: true } }] },
      ],
    };
    const text = `Output below.\n${JSON.stringify(obj)}\nDone.`;
    expect(extractJson(text)).toEqual(obj);
  });

  it('handles escaped quotes inside strings', () => {
    const text = `Notes:\n{"q": "He said \\"hi\\""}`;
    expect(extractJson(text)).toEqual({ q: 'He said "hi"' });
  });

  it('returns null when the input has no JSON at all', () => {
    expect(extractJson('I cannot generate this content. Please try again.')).toBeNull();
  });

  it('returns null when a JSON-looking substring is malformed', () => {
    // Brace count balanced but body is invalid JSON (missing colon).
    expect(extractJson('Output: { rows missing colon }')).toBeNull();
  });

  it('caps the candidate scan so an adversarial input does not hang', () => {
    // 200 stray opening braces in strings the scanner has to skip, then a
    // valid trailing JSON. With MAX_CANDIDATES = 50, the scanner may not
    // reach the trailing JSON — that's the deliberate trade-off. The
    // important property is that the call returns in bounded time.
    const adversarial = '{ '.repeat(200) + '\nfinal: {"ok": true}';
    const start = Date.now();
    const result = extractJson(adversarial);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    // Result may be null OR may have parsed one of the stray braces;
    // either is acceptable. We only assert the bounded-time property.
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('parses fenced JSON with prose preamble (real production case)', () => {
    const text = [
      '```json',
      'I noticed the script mentions Costa Rica, so I emphasized that beat.',
      '{"on_screen_text_mode_default": "overlay", "rows": []}',
      '```',
    ].join('\n');
    // Even though there's prose INSIDE the fences, the balanced-brace
    // scan still finds the JSON object.
    expect(extractJson(text)).toEqual({
      on_screen_text_mode_default: 'overlay',
      rows: [],
    });
  });
});
