/**
 * Tolerant JSON extractor for channel-clone LLM responses.
 *
 * Every runner's parser used to strip markdown fences and call
 * JSON.parse directly on the result. That breaks when the model
 * ignores "Output ONLY the JSON object" and prepends a header line
 * or appends a summary. Gemini 3.5 Flash via Kie has been observed
 * doing exactly this on rowify output, producing errors like:
 *   "Unexpected token '?', '🍡 Current'... is not valid JSON"
 *
 * Strategy:
 *   1. Strip leading and trailing markdown code fences, trim, try
 *      direct JSON.parse. Happy path stays a single JSON.parse call.
 *   2. On failure: find the first '{', walk character-by-character
 *      tracking brace depth and string context (with backslash
 *      escape), stop at the matching '}'. Parse that slice.
 *   3. If brace-matching never returns to depth 0, throw a clear
 *      "could not extract JSON" error rather than letting
 *      JSON.parse choke on the wrong substring.
 *
 * Used by every channel-clone parser. Pure function -- no I/O, no
 * deps. Unit tested in tests/channel-clone-parse-llm-json.test.ts.
 *
 * 2026-06-08 bugfix.
 */

export function extractJsonObjectFromModelResponse(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace-matching
  }
  const startIdx = cleaned.indexOf('{');
  if (startIdx < 0) {
    throw new Error('no JSON object found in response (no opening brace)');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;
  for (let i = startIdx; i < cleaned.length; i += 1) {
    const c = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) {
    throw new Error('could not extract JSON object: unbalanced braces');
  }
  return JSON.parse(cleaned.slice(startIdx, endIdx + 1));
}
