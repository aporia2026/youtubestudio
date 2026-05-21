/**
 * Workflow template placeholder injection.
 *
 * ComfyUI workflows are JSON graphs. Our templates live in
 * `src/lib/comfyui/workflows/*.json` and contain placeholders like
 * `<<PROMPT>>` / `<<WIDTH>>` / `<<SEED>>` inside string values. At
 * submit-time we substitute these with the caller's values and parse
 * the result into a `ComfyWorkflowGraph`.
 *
 * Why string-replace and not a structured template engine: ComfyUI's
 * inputs map is loosely typed (numbers, strings, tuples, etc.). A
 * string-substitution pass over the JSON text lets us treat numeric
 * placeholders the same as text ones — `<<WIDTH>>` becomes `1024`,
 * `<<PROMPT>>` becomes `"a fox in autumn forest"`, both via the same
 * mechanism. The JSON.parse at the end catches malformed substitutions
 * before we hit the wire.
 *
 * Placeholder convention: `<<NAME>>` (double angle brackets, uppercase
 * snake). Chosen because they never appear in legitimate JSON content.
 */
import type { ComfyWorkflowGraph } from './client';

/** Values supported in placeholder substitution. Strings get JSON-escaped
 *  and wrapped in quotes; numbers/booleans get serialised raw. */
export type PlaceholderValue = string | number | boolean;

/** Map of placeholder name (without delimiters) → substitution value. */
export type PlaceholderMap = Record<string, PlaceholderValue>;

const PLACEHOLDER_RE = /<<([A-Z][A-Z0-9_]*)>>/g;

/**
 * Substitute placeholders in a workflow template string and parse the
 * result. Throws if any placeholder is left unresolved or the JSON
 * becomes invalid after substitution.
 *
 * @param template  Raw JSON text with `<<NAME>>` placeholders inside
 *                  string values (e.g. `"text": "<<PROMPT>>"`).
 * @param values    Substitution map. Strings are JSON-escaped + quoted.
 * @returns         The parsed `ComfyWorkflowGraph` ready to send to /prompt.
 */
export function fillWorkflow(
  template: string,
  values: PlaceholderMap,
): ComfyWorkflowGraph {
  const seen = new Set<string>();
  const filled = template.replace(PLACEHOLDER_RE, (_, name: string) => {
    seen.add(name);
    if (!(name in values)) {
      throw new Error(`Workflow template references <<${name}>> but no value was provided`);
    }
    const v = values[name];
    if (typeof v === 'string') {
      // The placeholder is expected to live INSIDE a JSON string literal —
      // e.g. `"text": "<<PROMPT>>"`. Drop the surrounding quotes and
      // re-emit a fully-escaped JSON string. `JSON.stringify("hi")`
      // returns `"hi"` so we slice off the outer quotes.
      return JSON.stringify(v).slice(1, -1);
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new Error(`Placeholder <<${name}>> received non-finite number`);
      }
      // Numeric placeholders are typically positioned outside string
      // quotes in the template — e.g. `"width": <<WIDTH>>`. Replacing
      // with a bare number works in JSON.
      return String(v);
    }
    if (typeof v === 'boolean') {
      return v ? 'true' : 'false';
    }
    throw new Error(`Placeholder <<${name}>> received unsupported value type`);
  });

  // Catch typos in the caller's value map — values supplied that the
  // template doesn't actually use. Cheap but caught a real bug in early
  // testing.
  for (const k of Object.keys(values)) {
    if (!seen.has(k)) {
      throw new Error(`Value provided for <<${k}>> but template doesn't use it`);
    }
  }

  try {
    return JSON.parse(filled) as ComfyWorkflowGraph;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Workflow template produced invalid JSON after substitution: ${msg}`);
  }
}

/** Pick a deterministic-but-random seed in the range ComfyUI accepts.
 *  Uses `crypto.getRandomValues` so two simultaneous calls don't collide. */
export function randomSeed(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // ComfyUI accepts up to 2^53 - 1 (JavaScript number safe integer ceiling).
  // We use 48 bits so the seed fits comfortably and is reproducible.
  return buf[0] * 0x10000 + (buf[1] & 0xffff);
}
