/**
 * Parse JSON from LLM responses. Tries multiple extraction strategies:
 * 1. Extract from ```json ... ``` code blocks
 * 2. Find outermost { ... } pair
 * Falls back to throwing with a descriptive error.
 */
export function parseLlmJson(raw: string): unknown {
  // Strategy 1: code block
  const codeBlockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    return JSON.parse(codeBlockMatch[1]);
  }

  // Strategy 2: outermost braces
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  }

  throw new Error('No JSON object found in LLM response');
}
