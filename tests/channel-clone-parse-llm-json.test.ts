/**
 * Unit tests for the tolerant LLM-JSON extractor.
 *
 * The helper is the foundation under every channel-clone parser.
 * If the extractor silently mis-recovers JSON from a prose-wrapped
 * response, the wrong stage data lands on the job row. These tests
 * cover the realistic failure modes Gemini 3.5 Flash has shipped at
 * us (prose-before, prose-after, emoji header, brace-bearing
 * strings) plus the happy paths and the deliberately-invalid edge
 * cases that MUST throw.
 *
 * See src/lib/channel-clone/parse-llm-json.ts.
 */

import { describe, expect, it } from 'vitest';
import { extractJsonObjectFromModelResponse } from '@/lib/channel-clone/parse-llm-json';

describe('extractJsonObjectFromModelResponse: happy paths', () => {
  it('parses pure JSON', () => {
    const result = extractJsonObjectFromModelResponse('{"a":1,"b":"two"}');
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  it('strips a leading ```json … ``` fence', () => {
    const result = extractJsonObjectFromModelResponse('```json\n{"a":1}\n```');
    expect(result).toEqual({ a: 1 });
  });

  it('strips a bare ``` … ``` fence (no language hint)', () => {
    const result = extractJsonObjectFromModelResponse('```\n{"a":1}\n```');
    expect(result).toEqual({ a: 1 });
  });

  it('handles whitespace + newlines around the JSON', () => {
    const result = extractJsonObjectFromModelResponse('\n\n   {"a":1}   \n\n');
    expect(result).toEqual({ a: 1 });
  });
});

describe('extractJsonObjectFromModelResponse: tolerates LLM prose leakage', () => {
  it('recovers JSON when the model prepends an emoji header (the actual bug)', () => {
    const raw = '📍 Current breakdown:\n\n{"rows":[{"timecode":"0:00-0:03","script_text":"Hook"}]}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ rows: [{ timecode: '0:00-0:03', script_text: 'Hook' }] });
  });

  it('recovers JSON when the model appends a summary line', () => {
    const raw = '{"rows":[{"a":1}]}\n\nTotals: 1 row, ~5s of narration.';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ rows: [{ a: 1 }] });
  });

  it('recovers JSON with prose on both sides', () => {
    const raw = 'Here is the breakdown:\n\n{"a":1}\n\nLet me know if you need adjustments.';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ a: 1 });
  });

  it('strips the markdown fence WRAPPING the prose+JSON when present', () => {
    const raw = '```json\nHere is the result:\n{"a":1}\n```';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ a: 1 });
  });

  it('handles emoji characters that produce the � replacement char in bug reports', () => {
    // Reproducing the actual error: "Unexpected token '�', '🍡 Current'... is not valid JSON"
    const raw = '🍡 Current rowify output:\n{"rows":[]}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ rows: [] });
  });
});

describe('extractJsonObjectFromModelResponse: string-containing-braces edge cases', () => {
  it('does NOT terminate at a } inside a JSON string value', () => {
    const raw = 'header\n{"text":"unmatched } in here","a":1}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ text: 'unmatched } in here', a: 1 });
  });

  it('handles backslash-escaped quotes inside string values', () => {
    const raw = 'header\n{"text":"with \\"escaped\\" quotes","a":1}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ text: 'with "escaped" quotes', a: 1 });
  });

  it('handles nested objects', () => {
    const raw = 'header\n{"outer":{"inner":{"deep":1}},"sibling":"v"}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ outer: { inner: { deep: 1 } }, sibling: 'v' });
  });

  it('handles arrays of objects', () => {
    const raw = '{"rows":[{"a":1},{"a":2},{"a":3}]}';
    const result = extractJsonObjectFromModelResponse(raw);
    expect(result).toEqual({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
  });
});

describe('extractJsonObjectFromModelResponse: throws on un-recoverable input', () => {
  it('throws on empty input', () => {
    expect(() => extractJsonObjectFromModelResponse('')).toThrow();
  });

  it('throws on prose-only input (no opening brace)', () => {
    expect(() => extractJsonObjectFromModelResponse('the model refused to produce JSON'))
      .toThrow(/no opening brace|no JSON object found/);
  });

  it('throws on unbalanced braces', () => {
    expect(() => extractJsonObjectFromModelResponse('header\n{"a":1'))
      .toThrow(/unbalanced braces|could not extract/);
  });

  it('throws when the recovered substring is not valid JSON', () => {
    // `{` exists but the slice through the matching `}` is junk —
    // genuinely unparseable.
    expect(() => extractJsonObjectFromModelResponse('header\n{not even kinda json}'))
      .toThrow();
  });
});
