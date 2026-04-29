/**
 * Video Composer — LLM helper.
 *
 * Every stage calls generateJson() with a system prompt + user prompt and
 * receives a parsed, validated JSON object. Handles both Kie (cloud) and
 * Ollama (local) backends, with tolerant JSON extraction so a stray bit of
 * prose or code-fence doesn't crash a whole video.
 */

import { generateText } from '@/lib/ai';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export interface GenerateJsonOptions {
  backend: 'kie' | 'ollama';
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Soft cap. Large plans (many shots) may need a bigger ceiling. */
  maxTokens?: number;
  /** 0 for analysis (deterministic), 0.5–0.7 for composition (creative). */
  temperature?: number;
  /** Apply Anthropic prompt caching to the system prompt. Defaults to true
   *  because every composer stage has a stable per-stage system prompt that
   *  repeats across convergence iterations. Set false to opt out if a stage
   *  ever varies its system prompt call-to-call (cache would never hit). */
  cache?: boolean;
  /** Optional stable prefix of the user prompt (e.g. brief + script) that
   *  should carry its own Anthropic cache breakpoint. Pass the raw prefix
   *  string; on Anthropic it becomes a cached text block; on other providers
   *  it is concatenated back in front of `userPrompt` for identical semantics. */
  userCachePrefix?: string;
}

export interface GenerateJsonResult<T> {
  data: T;
  raw: string;
  model: string;
  backend: 'kie' | 'ollama';
}

export async function generateJson<T>(opts: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
  const maxTokens = opts.maxTokens ?? 6000;
  const temperature = opts.temperature ?? 0.4;

  let raw: string;
  if (opts.backend === 'ollama') {
    raw = await generateViaOllama(opts.model, opts.systemPrompt, opts.userPrompt, temperature);
  } else {
    raw = await generateText({
      modelId: opts.model,
      prompt: opts.userPrompt,
      systemPrompt: opts.systemPrompt,
      maxTokens,
      temperature,
      // Composer stages (intake/analyze/plan/compose/critic/chair/charter) all
      // have stable per-stage system prompts that repeat across convergence
      // iterations — ideal for Anthropic prompt caching. No-op on non-Anthropic
      // providers (Gemini, OpenAI, Perplexity). Caller can opt out via cache:false.
      cache: opts.cache ?? true,
      userCachePrefix: opts.userCachePrefix,
    });
  }

  const json = extractJson(raw);
  if (!json) {
    throw new Error(`Model returned no valid JSON. Preview: ${raw.slice(0, 300)}`);
  }

  let data: T;
  try {
    data = JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse model JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Preview: ${json.slice(0, 300)}`
    );
  }

  return { data, raw, model: opts.model, backend: opts.backend };
}

async function generateViaOllama(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      format: 'json',
      stream: false,
      options: { temperature, num_ctx: 32768 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json() as { message?: { content?: string }; error?: string };
  if (data.error) throw new Error(data.error);
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned empty response');
  return content;
}

/** Pulls the first complete JSON object/array out of an arbitrary string. */
export function extractJson(s: string): string | null {
  // ```json ... ``` fences
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // First balanced { ... } or [ ... ]
  const openIdx = findFirst(s, ['{', '[']);
  if (openIdx === -1) return null;
  const open = s[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(openIdx, i + 1);
    }
  }
  return null;
}

function findFirst(s: string, chars: string[]): number {
  let best = -1;
  for (const ch of chars) {
    const idx = s.indexOf(ch);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}
