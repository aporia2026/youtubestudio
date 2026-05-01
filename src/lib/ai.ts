// Server-only AI provider abstraction — supports Anthropic, OpenAI, Google, Kie.ai, Perplexity
// Do NOT import this file from client components — import from ai-models.ts instead.

export type { AIProvider, AIModel } from './ai-models';
export { AI_MODELS, getDefaultModel, getModelById } from './ai-models';

import { getModelById } from './ai-models';
import { KIE_MODEL_MAP } from './ai-models';
import { cookies } from 'next/headers';

async function getPerplexityKey(): Promise<string> {
  if (process.env.PERPLEXITY_API_KEY) return process.env.PERPLEXITY_API_KEY;
  try {
    const store = await cookies();
    const key = store.get('perplexity_api_key')?.value;
    if (key) return key;
  } catch { /* not in a request context */ }
  throw new Error('Perplexity API key is not configured. Add it in Settings → API Keys.');
}

const KIE_BASE = 'https://api.kie.ai';

export interface GenerateOptions {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Optional image for multimodal analysis (e.g. video thumbnail) */
  image?: { base64: string; mimeType: string };
  /** Apply Anthropic prompt caching to the system prompt. Safe to set
   *  anywhere — ignored by non-Anthropic providers. Anthropic requires
   *  ≥1024 tokens (≥2048 on Haiku) to activate the cache; below that
   *  it's a silent no-op, not an error. */
  cache?: boolean;
  /** When set AND `cache` is true, the Anthropic branch sends user content
   *  as two text blocks: `[{text: userCachePrefix, cache_control}, {text: prompt}]`.
   *  Use this when the stable portion of the user message (e.g. charter + script
   *  on a convergence run) sits in front of per-call varying tail (feedback,
   *  iteration-specific drafts). Non-Anthropic providers receive
   *  `userCachePrefix + prompt` concatenated — identical semantics, no cache
   *  mechanic, so callers don't need to branch on provider. */
  userCachePrefix?: string;
}

// --- Kie.ai helpers ---

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured. Set it in your Vercel project settings.');
  return key;
}

/**
 * Detect Kie's "HTTP 200 with error envelope" response. Confirmed live
 * during a gemini-3.1-pro outage:
 *   { "code": 500, "msg": "The server is currently being maintained, ..." }
 * The HTTP status is 200, so res.ok and kieRetry both think it succeeded.
 * Without this check we'd extract empty content and the script-validated
 * path would silently loop until "All generation attempts failed".
 *
 * Throws a useful error when the body carries a non-OK code so the caller
 * surfaces Kie's actual message to the user.
 */
function throwIfKieBodyError(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const obj = data as Record<string, unknown>;
  // Only treat as an error when there's a `code` field AND no `choices`.
  // Successful chat-completions responses sometimes carry a code/status
  // field that's safe to ignore as long as the assistant message exists.
  if ('code' in obj && !('choices' in obj)) {
    const code = obj.code;
    const msg = (obj.msg ?? obj.message ?? 'Kie returned an error envelope') as string;
    if (code != null && code !== 0 && code !== 200) {
      throw new Error(`Kie gateway error (code ${code}): ${msg}`);
    }
  }
}

/**
 * Extract assistant text from a Kie Gemini chat-completions response.
 * Robust to multiple shapes the gateway has returned across model
 * versions:
 *   - choices[0].message.content as a plain string (OpenAI standard)
 *   - choices[0].message.content as an array of {type, text} blocks
 *     (the gemini-3.x request shape — some versions echo the same shape
 *     in responses)
 *   - choices[0].message.reasoning_content (defense in depth — visible
 *     content can land here when include_thoughts isn't honored)
 *   - choices[0].text (legacy completions fallback)
 */
function extractKieGeminiContent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  const choices = obj.choices as unknown[] | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  const messageContent = message?.content;
  if (typeof messageContent === 'string' && messageContent.length > 0) {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    const parts: string[] = [];
    for (const block of messageContent) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
        else if (typeof b.content === 'string') parts.push(b.content);
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  // Some configurations route visible output to reasoning_content when
  // include_thoughts is on. Fall back to it so we don't return empty.
  if (typeof message?.reasoning_content === 'string') {
    return message.reasoning_content as string;
  }
  if (typeof first.text === 'string') return first.text as string;
  return '';
}

async function kieGeminiFetch(kieModelId: string, prompt: string, systemPrompt?: string, stream = false, maxTokens = 4000) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/${kieModelId}/v1/chat/completions`;

  // Kie's gemini-3.x routes (gemini-3-flash, gemini-3-pro, gemini-3.1-pro)
  // require `content` to be an ARRAY of content blocks, not a plain string.
  // Older 2.x routes accept both, but 3.x silently 200s with an empty body
  // when given the legacy string form. Sending the array form universally
  // is OpenAI-compatible and works on every Kie route.
  // Ref: https://docs.kie.ai/market/gemini/gemini-3-1-pro
  type ContentBlock = { type: 'text'; text: string };
  const messages: { role: string; content: ContentBlock[] }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] });

  const body: Record<string, unknown> = { messages, stream, max_tokens: maxTokens };

  // Gemini 3.x defaults `include_thoughts` to TRUE on Kie's gateway. With
  // thoughts on, the model burns most of its token budget reasoning and
  // returns a thin (or empty) final message — the exact failure we kept
  // hitting on 3.1-pro: 200 OK, message.content empty, script-validated
  // bails with "All generation attempts failed". We never read the thoughts
  // anywhere in this app, so disabling them frees the full max_tokens for
  // actual output. No effect on routes that don't recognize the field.
  // Ref: https://docs.kie.ai/market/gemini/gemini-3-1-pro
  if (kieModelId.startsWith('gemini-3')) {
    body.include_thoughts = false;
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function kieClaudeFetch(kieModelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000, stream = false, cache = false) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/claude/v1/messages`;
  const body: Record<string, unknown> = {
    model: kieModelId,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    stream,
  };
  if (systemPrompt) {
    // Note: `cache` is accepted but NOT applied for Kie's Claude pass-through.
    // Kie's /claude/v1/messages may or may not forward Anthropic cache_control
    // markers verbatim — attempted to smoke-test on 2026-04-18 but the Kie
    // Claude endpoint was in maintenance (500s); Gemini endpoint responded
    // normally. Until a clean test confirms array-form `system` is accepted,
    // we stay on string-form here.
    // TODO: re-run smoke test when Kie Claude endpoint is healthy and flip on.
    void cache;
    body.system = systemPrompt;
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function kieGptResponsesFetch(kieModelId: string, prompt: string, systemPrompt?: string, stream = false, maxTokens = 4000) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/codex/v1/responses`;
  const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: kieModelId, input, stream, max_tokens: maxTokens }),
  });
}

// --- Error helpers ---

/** Extract a clean error message from a failed kie.ai response.
 *  Strips HTML (Cloudflare gateway pages) and truncates long messages. */
async function kieErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  // If the body is HTML (Cloudflare / nginx gateway error pages), return a clean message
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503) {
      return `Kie.ai is temporarily unavailable (${res.status} gateway error) — please try again in a moment`;
    }
    return `Kie.ai returned an unexpected response (HTTP ${res.status})`;
  }
  // Try to extract a message from JSON error responses
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string') return `Kie.ai error: ${msg}`;
  } catch { /* not JSON */ }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

/** Retry a fetch up to `attempts` times for transient 502/503/504 errors. */
async function kieRetry(fn: () => Promise<Response>, attempts = 3): Promise<Response> {
  let last!: Response;
  for (let i = 0; i < attempts; i++) {
    const res = await fn();
    if (res.status !== 502 && res.status !== 503 && res.status !== 504) return res;
    last = res;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return last;
}

// --- Non-streaming ---

async function kieGenerateText(modelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000, cache = false): Promise<string> {
  const config = KIE_MODEL_MAP[modelId];
  if (!config) throw new Error(`Unknown Kie model: ${modelId}`);

  if (config.endpointType === 'gemini') {
    const res = await kieRetry(() => kieGeminiFetch(config.kieModelId, prompt, systemPrompt, false, maxTokens));
    if (!res.ok) throw new Error(await kieErrorMessage(res));
    const data = await res.json();
    throwIfKieBodyError(data);
    return extractKieGeminiContent(data);
  }

  if (config.endpointType === 'claude') {
    const res = await kieRetry(() => kieClaudeFetch(config.kieModelId, prompt, systemPrompt, maxTokens, false, cache));
    if (!res.ok) throw new Error(await kieErrorMessage(res));
    const data = await res.json();
    // Find the text block — skip thinking blocks
    const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
    return textBlock?.text || '';
  }

  if (config.endpointType === 'gpt-responses') {
    const res = await kieRetry(() => kieGptResponsesFetch(config.kieModelId, prompt, systemPrompt, false, maxTokens));
    if (!res.ok) throw new Error(await kieErrorMessage(res));
    const data = await res.json();
    // Responses API: output is in output[].content[].text or output_text
    if (data.output_text) return data.output_text;
    const output = data.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const block of item.content) {
            if (block.type === 'output_text') return block.text;
          }
        }
      }
    }
    return '';
  }

  throw new Error(`Unknown Kie endpoint type: ${config.endpointType}`);
}

// --- Streaming ---

async function* kieStreamText(modelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000, cache = false): AsyncGenerator<string> {
  const config = KIE_MODEL_MAP[modelId];
  if (!config) throw new Error(`Unknown Kie model: ${modelId}`);

  let res: Response;

  if (config.endpointType === 'gemini') {
    res = await kieRetry(() => kieGeminiFetch(config.kieModelId, prompt, systemPrompt, true, maxTokens));
  } else if (config.endpointType === 'claude') {
    res = await kieRetry(() => kieClaudeFetch(config.kieModelId, prompt, systemPrompt, maxTokens, true, cache));
  } else if (config.endpointType === 'gpt-responses') {
    res = await kieRetry(() => kieGptResponsesFetch(config.kieModelId, prompt, systemPrompt, true, maxTokens));
  } else {
    throw new Error(`Unknown Kie endpoint type: ${config.endpointType}`);
  }

  if (!res.ok) throw new Error(await kieErrorMessage(res));
  if (!res.body) throw new Error('No response body from Kie.ai');

  // Detect Kie's "200 + error envelope" trick on stream requests too —
  // when a model is in maintenance the gateway sometimes returns a plain
  // JSON body (not SSE) on a route the client asked to stream. Without
  // this peek we'd consume zero SSE events and yield nothing, leaving
  // the caller to think the model returned empty.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const errBody = await res.text();
    try {
      const parsed = JSON.parse(errBody);
      throwIfKieBodyError(parsed);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Kie gateway error')) throw e;
    }
    throw new Error(`Kie returned a non-stream response on a stream request: ${errBody.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);

        if (config.endpointType === 'gemini') {
          // OpenAI chat completions SSE format
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } else if (config.endpointType === 'claude') {
          // Anthropic SSE format
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } else if (config.endpointType === 'gpt-responses') {
          // OpenAI Responses API SSE format
          if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            yield parsed.delta;
          }
        }
      } catch {
        // skip unparseable SSE lines
      }
    }
  }
}

// --- Shared multimodal helpers ---

/** Build Anthropic user-message content. When `userCachePrefix` is provided,
 *  emits it as its own text block with `cache_control: ephemeral` so the
 *  stable portion of the user message hits Anthropic's prompt cache
 *  independently of the varying tail in `prompt`. */
 
function buildAnthropicContent(
  prompt: string,
  image?: { base64: string; mimeType: string },
  userCachePrefix?: string,
): any {
  const prefixBlock = userCachePrefix
    ? [{ type: 'text' as const, text: userCachePrefix, cache_control: { type: 'ephemeral' as const } }]
    : [];
  if (!image && !userCachePrefix) return prompt;
  if (!image) return [...prefixBlock, { type: 'text' as const, text: prompt }];
  return [
    { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: image.base64 } },
    ...prefixBlock,
    { type: 'text' as const, text: prompt },
  ];
}

/** Non-Anthropic providers don't get a cache breakpoint in user content —
 *  fold the prefix into the prompt so the message is semantically identical
 *  and callers don't need to branch on provider. */
function mergeUserCachePrefix(prompt: string, userCachePrefix?: string): string {
  return userCachePrefix ? `${userCachePrefix}\n\n${prompt}` : prompt;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildOpenAIMessages(prompt: string, systemPrompt?: string, image?: { base64: string; mimeType: string }): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  if (image) {
    msgs.push({ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
      { type: 'text', text: prompt },
    ]});
  } else {
    msgs.push({ role: 'user', content: prompt });
  }
  return msgs;
}

/**
 * Build chat-completions params per OpenAI model family.
 *
 *  - o3 / o3-mini / o4-mini / future o-series: REASONING models. They
 *    require `max_completion_tokens` (the older `max_tokens` is rejected)
 *    and forbid non-default temperature ("Only the default (1) value is
 *    supported"). Passing temperature on these models 400s the request.
 *
 *  - gpt-5 / gpt-5-mini / gpt-5-nano: chat models that prefer the new
 *    `max_completion_tokens` param (max_tokens still works for now but
 *    is deprecated). Temperature is honored.
 *
 *  - gpt-4.1 / gpt-4o / earlier: legacy `max_tokens` + `temperature`.
 *
 * Without this branching, every o-series pick fails at the API level —
 * which is what was happening before this fix.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildOpenAIChatParams(modelId: string, messages: any[], maxTokens: number, temperature: number, stream: boolean): any {
  const isReasoning = /^o[0-9]/.test(modelId); // o3, o3-mini, o4-mini, future o5...
  const isGpt5 = modelId.startsWith('gpt-5');
  const useCompletionTokens = isReasoning || isGpt5;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { model: modelId, messages, stream };
  if (useCompletionTokens) {
    params.max_completion_tokens = maxTokens;
  } else {
    params.max_tokens = maxTokens;
  }
  if (!isReasoning) {
    params.temperature = temperature;
  }
  return params;
}

// --- Main exports ---

export async function generateText(opts: GenerateOptions): Promise<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;
  // Non-Anthropic providers don't get a user-content cache breakpoint — we fold
  // the prefix into the prompt so the message is semantically identical. The
  // Anthropic branch below takes the raw prompt + prefix separately.
  const effectivePrompt = mergeUserCachePrefix(opts.prompt, opts.userCachePrefix);

  if (model.provider === 'kie') {
    return kieGenerateText(opts.modelId, effectivePrompt, systemPrompt, maxTokens, opts.cache);
  }

  if (model.provider === 'perplexity') {
    const perplexityKey = await getPerplexityKey();
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: effectivePrompt });
    // Reasoning + deep-research variants are sensitive to high temperature — lock them low
    const isReasoning = model.id.includes('reasoning') || model.id.includes('deep-research');
    const effectiveTemp = isReasoning ? Math.min(0.1, temperature) : temperature;
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${perplexityKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages, max_tokens: maxTokens, temperature: effectiveTemp }),
    });
    if (!res.ok) throw new Error(`Perplexity error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (model.provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY environment variable is not configured');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // Only emit the user-content cache prefix block when cache is actually on.
    const msgContent = buildAnthropicContent(opts.prompt, opts.image, opts.cache ? opts.userCachePrefix : undefined);
    // Promote `system` to blocks form with cache_control when opts.cache is set —
    // identical system prompts across calls (e.g. same critic across a convergence
    // run) hit the ephemeral prompt cache. Reads bill at ~10% of input, writes at
    // ~125%. Prompts under ~1024 tokens (~2048 on Haiku) silently don't cache.
    const systemParam = (systemPrompt && opts.cache)
      ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : systemPrompt;
    const response = await client.messages.create({
      model: model.id,
      max_tokens: maxTokens,
      temperature,
      system: systemParam,
      messages: [{ role: 'user', content: msgContent }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type');
    return block.text;
  }

  if (model.provider === 'openai') {
    const OpenAI = (await import('openai')).default;
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY environment variable is not configured');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const msgs = buildOpenAIMessages(effectivePrompt, systemPrompt, opts.image);
    const response = await client.chat.completions.create(
      buildOpenAIChatParams(model.id, msgs, maxTokens, temperature, false),
    );
    return response.choices[0].message.content || '';
  }

  if (model.provider === 'google') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    if (!process.env.GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY environment variable is not configured');
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    const gemini = genAI.getGenerativeModel({ model: model.id, generationConfig: { temperature, maxOutputTokens: maxTokens } });
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${effectivePrompt}` : effectivePrompt;
    try {
      if (opts.image) {
        const result = await gemini.generateContent([
          fullPrompt,
          { inlineData: { mimeType: opts.image.mimeType, data: opts.image.base64 } },
        ]);
        return result.response.text();
      }
      const result = await gemini.generateContent(fullPrompt);
      return result.response.text();
    } catch (err) {
      throw rewriteGoogleError(err, model.id);
    }
  }

  throw new Error(`Unsupported provider: ${model.provider}`);
}

/**
 * Google's GoogleGenerativeAI SDK throws a verbose error that buries the
 * actionable bit ("models/X is not found for API version v1beta") in a
 * long URL string. When the model literally doesn't exist on Google's
 * public API (e.g. anything we listed speculatively before Google shipped
 * the corresponding 3.x release), rewrite the error so the toast tells the
 * user to pick a different model instead of a wall of URL noise.
 */
function rewriteGoogleError(err: unknown, modelId: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b404\b|not found|is not supported for/i.test(msg)) {
    return new Error(
      `Google's API doesn't have "${modelId}" available right now. This usually means the model was listed before Google shipped it, or it was renamed/removed. Pick a different model — gemini-2.5-pro and the kie-* variants are known-good fallbacks.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ============================================================
// Gemini-only: native YouTube video analysis
// Gemini accepts YouTube URLs directly via fileData parts and sees
// the actual video (visual + audio + on-screen text) — no frame
// extraction or transcription pipeline needed.
// ============================================================

export interface VideoAnalysisOptions {
  modelId: string;
  youtubeUrl: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function analyzeYouTubeVideo(opts: VideoAnalysisOptions): Promise<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  // Direct Google provider — cleanest path
  if (model.provider === 'google') {
    if (!process.env.GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY environment variable is not configured');
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    const gemini = genAI.getGenerativeModel({
      model: model.id,
      generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.maxTokens ?? 8000 },
    });
    const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
    const result = await gemini.generateContent([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { fileData: { fileUri: opts.youtubeUrl, mimeType: 'video/*' } } as any,
      { text: fullPrompt },
    ]);
    return result.response.text();
  }

  // Kie.ai Gemini — uses the OpenAI-compatible chat/completions endpoint with a unified
  // media format: {type: "image_url", image_url: {url}} works for images, videos, audio,
  // and documents alike (per docs.kie.ai/market/gemini/gemini-3-pro). YouTube URLs are
  // not explicitly documented but pass through to Google's underlying Gemini API which
  // does accept them natively.
  if (model.provider === 'kie') {
    const config = KIE_MODEL_MAP[opts.modelId];
    if (!config || config.endpointType !== 'gemini') {
      throw new Error('Video analysis requires a Gemini model. Selected Kie.ai model is not Gemini.');
    }
    const apiKey = requireKieKey();
    const url = `${KIE_BASE}/${config.kieModelId}/v1/chat/completions`;
    const messages = [
      ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt },
          { type: 'image_url', image_url: { url: opts.youtubeUrl } },
        ],
      },
    ];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: opts.maxTokens ?? 8000,
        temperature: opts.temperature ?? 0.3,
      }),
    });
    if (!res.ok) {
      const clean = await kieErrorMessage(res);
      throw new Error(`${clean}. Note: YouTube URL support via Kie.ai is undocumented — if this fails consistently, switch to a direct Google Gemini model.`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(
    `Video analysis is only supported on Gemini models. Selected provider "${model.provider}" does not support native video input. ` +
    'Pick any Gemini model (direct Google or via Kie.ai) from the model selector.',
  );
}

/** True if the model can natively analyze YouTube videos. */
export function modelSupportsVideo(modelId: string): boolean {
  const m = getModelById(modelId);
  if (!m) return false;
  if (m.provider === 'google') return true;
  if (m.provider === 'kie') {
    const cfg = KIE_MODEL_MAP[modelId];
    return !!cfg && cfg.endpointType === 'gemini';
  }
  return false;
}

// Streaming version for real-time UI updates
export async function* generateTextStream(opts: GenerateOptions): AsyncGenerator<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;
  const effectivePrompt = mergeUserCachePrefix(opts.prompt, opts.userCachePrefix);

  if (model.provider === 'kie') {
    yield* kieStreamText(opts.modelId, effectivePrompt, systemPrompt, maxTokens, opts.cache);
    return;
  }

  if (model.provider === 'perplexity') {
    const perplexityKey = await getPerplexityKey();
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: effectivePrompt });
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${perplexityKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        messages,
        max_tokens: maxTokens,
        temperature: (model.id.includes('reasoning') || model.id.includes('deep-research')) ? Math.min(0.1, temperature) : temperature,
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(`Perplexity stream error ${res.status}: ${await res.text()}`);
    if (!res.body) throw new Error('No response body from Perplexity');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* skip */ }
      }
    }
    return;
  }

  if (model.provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY environment variable is not configured');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msgContent = buildAnthropicContent(opts.prompt, opts.image, opts.cache ? opts.userCachePrefix : undefined);
    const systemParam = (systemPrompt && opts.cache)
      ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : systemPrompt;
    const stream = client.messages.stream({
      model: model.id,
      max_tokens: maxTokens,
      temperature,
      system: systemParam,
      messages: [{ role: 'user', content: msgContent }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
    return;
  }

  if (model.provider === 'openai') {
    const OpenAI = (await import('openai')).default;
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY environment variable is not configured');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const msgs = buildOpenAIMessages(effectivePrompt, systemPrompt, opts.image);
    // The SDK picks its return type from the literal shape of the params
    // object; building params dynamically loses that, so cast through
    // unknown to the streaming async iterable.
    const stream = await client.chat.completions.create(
      buildOpenAIChatParams(model.id, msgs, maxTokens, temperature, true),
    ) as unknown as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
    return;
  }

  if (model.provider === 'google') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    if (!process.env.GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY environment variable is not configured');
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    const gemini = genAI.getGenerativeModel({ model: model.id, generationConfig: { temperature, maxOutputTokens: maxTokens } });
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${effectivePrompt}` : effectivePrompt;
    try {
      if (opts.image) {
        const result = await gemini.generateContentStream([
          fullPrompt,
          { inlineData: { mimeType: opts.image.mimeType, data: opts.image.base64 } },
        ]);
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) yield text;
        }
      } else {
        const result = await gemini.generateContentStream(fullPrompt);
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) yield text;
        }
      }
    } catch (err) {
      throw rewriteGoogleError(err, model.id);
    }
    return;
  }

  throw new Error(`Streaming not supported for provider: ${model.provider}`);
}
