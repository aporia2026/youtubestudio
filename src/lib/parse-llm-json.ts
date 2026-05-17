/**
 * Parse JSON from LLM responses. Tries multiple extraction strategies:
 * 1. Extract from ```json ... ``` code blocks
 * 2. Slice from the earliest top-level opener (`{` or `[`) to its
 *    matching last closer
 * Falls back to throwing with a descriptive error.
 */
export function parseLlmJson(raw: string): unknown {
  // Strategy 1: code block
  const codeBlockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    return JSON.parse(codeBlockMatch[1]);
  }

  // Strategy 2: outermost JSON value. Pick whichever delimiter opens
  // first in the raw text — if `{` appears first, the payload is an
  // object; if `[` appears first, it's an array. Naively trying braces
  // before brackets corrupts array-of-objects payloads: the first `{`
  // is inside the array, the last `}` is also inside, and the slice
  // between them ends up as `{...},{...},{...}` — invalid JSON.
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  const useBracket =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  if (useBracket) {
    const lastBracket = raw.lastIndexOf(']');
    if (lastBracket > firstBracket) {
      return JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    }
  } else if (firstBrace !== -1) {
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    }
  }

  throw new Error('No JSON found in LLM response');
}
