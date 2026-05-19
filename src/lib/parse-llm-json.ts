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

/**
 * Salvage as many complete top-level objects as possible from a truncated
 * JSON array. Designed for the case where an LLM emitted
 * `{"candidates": [{...}, {...}, {...incomplete`
 * (or a bare `[{...}, {...}, {...incomplete`) because the model hit its
 * output token cap mid-array. `parseLlmJson` correctly fails on that input;
 * this helper walks the first `[` in the text, collects each fully-formed
 * `{...}` object (depth-aware, string-aware), and stops at the first
 * incomplete one.
 *
 * Returns the salvaged array, or `null` if nothing could be recovered.
 * Callers should treat a non-null result as best-effort partial data and
 * surface that fact (e.g. log + reduced count) rather than silently pretend
 * the model returned the full set.
 *
 * Intentionally NOT folded into `parseLlmJson`'s strategy ladder: that
 * function is called by ~20 sites, many of which expect an OBJECT shape
 * (e.g. `{ ideas: [...] }`), and an aggressive array-salvage fallback
 * would mask malformed-object errors at those sites.
 */
export function salvageTruncatedJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf('[');
  if (start === -1) return null;

  const objects: unknown[] = [];
  let i = start + 1;
  const n = raw.length;

  while (i < n) {
    // Skip whitespace and commas between elements
    while (i < n) {
      const ch = raw[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') i++;
      else break;
    }
    if (i >= n) break;
    if (raw[i] === ']') break; // array properly closed — should've parsed via strategy 2, but be safe
    if (raw[i] !== '{') break; // non-object element — give up rather than guess

    // Walk to the matching `}` at depth 0, respecting strings and escapes.
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let objEnd = -1;
    for (let j = i; j < n; j++) {
      const ch = raw[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = j; break; }
      }
    }

    if (objEnd === -1) break; // truncated mid-object — stop salvaging

    try {
      objects.push(JSON.parse(raw.slice(objStart, objEnd + 1)));
    } catch {
      break; // malformed object — stop rather than skip silently
    }

    i = objEnd + 1;
  }

  return objects.length > 0 ? objects : null;
}
