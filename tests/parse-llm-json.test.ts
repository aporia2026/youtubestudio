import { describe, it, expect } from 'vitest';
import { parseLlmJson, salvageTruncatedJsonArray } from '../src/lib/parse-llm-json';

/**
 * parseLlmJson + salvageTruncatedJsonArray — the two helpers the
 * /api/generate/ideas route leans on. The bug they protect against
 * (2026-05-30): GPT-5.x emitting a `{ "ideas": [...] }` payload that
 * gets truncated mid-array when the schema is large, leaving the
 * response unparseable and the user staring at "Failed to parse
 * ideas response — try again" on every attempt. The salvage helper
 * pulls the complete prefix objects out of the truncated array so
 * a partial response beats a hard failure.
 */
describe('parseLlmJson', () => {
  it('parses a clean JSON object', () => {
    expect(parseLlmJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a ```json code fence', () => {
    expect(parseLlmJson('```json\n{"ideas": []}\n```')).toEqual({ ideas: [] });
  });

  it('parses an array-shaped payload (no leading object)', () => {
    expect(parseLlmJson('[{"id": "a"}, {"id": "b"}]')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('recovers from prose preamble before the JSON object', () => {
    const text = 'Here you go:\n\n{"ideas": [{"title": "t"}]}';
    expect(parseLlmJson(text)).toEqual({ ideas: [{ title: 't' }] });
  });

  it('throws on truncated JSON that cannot be parsed naively', () => {
    // This is the failure shape the ideas route was hitting:
    // model emits a valid `{"ideas": [...]}` opening then runs out of
    // tokens mid-object. parseLlmJson cannot rescue this — that's the
    // salvage helper's job.
    const truncated = '{"ideas": [{"title": "first"}, {"title": "seco';
    expect(() => parseLlmJson(truncated)).toThrow();
  });

  it('throws when no JSON delimiter is present at all', () => {
    expect(() => parseLlmJson('I cannot help with that.')).toThrow();
  });
});

describe('salvageTruncatedJsonArray', () => {
  it('salvages complete idea objects from a truncated `{ ideas: [...] }` payload', () => {
    // Real failure shape: GPT-5.x emits the wrapper + a couple of full
    // idea objects, then hits max_completion_tokens mid-object. The
    // route now calls this helper and treats the result as the ideas
    // array, returning a partial response rather than failing 500.
    const truncated = [
      '{',
      '  "ideas": [',
      '    { "title": "Why Antivirus Is Dead", "hook": "Most people are paying for nothing." },',
      '    { "title": "5 Cybersecurity Myths", "hook": "Number 3 will surprise you." },',
      '    { "title": "Truncated mid-emit", "hook": "starts but never close',
    ].join('\n');
    const salvaged = salvageTruncatedJsonArray(truncated);
    expect(salvaged).not.toBeNull();
    expect(salvaged).toHaveLength(2);
    expect((salvaged![0] as { title: string }).title).toBe('Why Antivirus Is Dead');
    expect((salvaged![1] as { title: string }).title).toBe('5 Cybersecurity Myths');
  });

  it('handles strings containing braces and escaped quotes without losing track of depth', () => {
    const truncated = [
      '{ "ideas": [',
      '  { "title": "He said \\"hi\\"", "hook": "Use {curly} braces in a quote" },',
      '  { "title": "Second", "hook": "ok" },',
      '  { "title": "third unfin',
    ].join('\n');
    const salvaged = salvageTruncatedJsonArray(truncated);
    expect(salvaged).toHaveLength(2);
    expect((salvaged![0] as { title: string }).title).toBe('He said "hi"');
    expect((salvaged![1] as { title: string }).title).toBe('Second');
  });

  it('returns the full array when the model emitted complete JSON', () => {
    // The route currently only invokes salvage on parse failure, but
    // the helper should still behave sensibly on a complete payload.
    const complete = '{"ideas": [{"title": "a"}, {"title": "b"}]}';
    const salvaged = salvageTruncatedJsonArray(complete);
    expect(salvaged).toHaveLength(2);
  });

  it('returns null when the payload truncates before the first complete object', () => {
    // Worst case: the model started the first object but never closed
    // it. Nothing to salvage. The route falls through to the existing
    // "Failed to parse" error path here, which is correct behaviour.
    const tooEarly = '{"ideas": [{"title": "barely sta';
    expect(salvageTruncatedJsonArray(tooEarly)).toBeNull();
  });

  it('returns null when there is no array at all in the input', () => {
    expect(salvageTruncatedJsonArray('I cannot help with that.')).toBeNull();
    expect(salvageTruncatedJsonArray('{"error": "model refused"}')).toBeNull();
  });

  it('stops at the first malformed object instead of skipping silently', () => {
    // If an object is structurally invalid (missing colon, stray
    // character) the helper must stop rather than skip — silently
    // skipping would let bad data into the downstream pipeline.
    const mixed = [
      '{ "ideas": [',
      '  { "title": "first valid" },',
      '  { malformed without quotes },',
      '  { "title": "third would-be-valid" }',
      ']}',
    ].join('\n');
    const salvaged = salvageTruncatedJsonArray(mixed);
    expect(salvaged).toHaveLength(1);
    expect((salvaged![0] as { title: string }).title).toBe('first valid');
  });
});
