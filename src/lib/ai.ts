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
}

// --- Kie.ai helpers ---

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured. Set it in your Vercel project settings.');
  return key;
}

async function kieGeminiFetch(kieModelId: string, prompt: string, systemPrompt?: string, stream = false) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/${kieModelId}/v1/chat/completions`;
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages, stream }),
  });
}

async function kieClaudeFetch(kieModelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000, stream = false) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/claude/v1/messages`;
  const body: Record<string, unknown> = {
    model: kieModelId,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    stream,
  };
  if (systemPrompt) body.system = systemPrompt;

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function kieGptResponsesFetch(kieModelId: string, prompt: string, systemPrompt?: string, stream = false) {
  const apiKey = requireKieKey();
  const url = `${KIE_BASE}/codex/v1/responses`;
  const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: kieModelId, input, stream }),
  });
}

// --- Non-streaming ---

async function kieGenerateText(modelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000): Promise<string> {
  const config = KIE_MODEL_MAP[modelId];
  if (!config) throw new Error(`Unknown Kie model: ${modelId}`);

  if (config.endpointType === 'gemini') {
    const res = await kieGeminiFetch(config.kieModelId, prompt, systemPrompt, false);
    if (!res.ok) throw new Error(`Kie.ai error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (config.endpointType === 'claude') {
    const res = await kieClaudeFetch(config.kieModelId, prompt, systemPrompt, maxTokens, false);
    if (!res.ok) throw new Error(`Kie.ai error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // Find the text block — skip thinking blocks
    const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
    return textBlock?.text || '';
  }

  if (config.endpointType === 'gpt-responses') {
    const res = await kieGptResponsesFetch(config.kieModelId, prompt, systemPrompt, false);
    if (!res.ok) throw new Error(`Kie.ai error ${res.status}: ${await res.text()}`);
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

async function* kieStreamText(modelId: string, prompt: string, systemPrompt?: string, maxTokens = 4000): AsyncGenerator<string> {
  const config = KIE_MODEL_MAP[modelId];
  if (!config) throw new Error(`Unknown Kie model: ${modelId}`);

  let res: Response;

  if (config.endpointType === 'gemini') {
    res = await kieGeminiFetch(config.kieModelId, prompt, systemPrompt, true);
  } else if (config.endpointType === 'claude') {
    res = await kieClaudeFetch(config.kieModelId, prompt, systemPrompt, maxTokens, true);
  } else if (config.endpointType === 'gpt-responses') {
    res = await kieGptResponsesFetch(config.kieModelId, prompt, systemPrompt, true);
  } else {
    throw new Error(`Unknown Kie endpoint type: ${config.endpointType}`);
  }

  if (!res.ok) throw new Error(`Kie.ai stream error ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error('No response body from Kie.ai');

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAnthropicContent(prompt: string, image?: { base64: string; mimeType: string }): any {
  if (!image) return prompt;
  return [
    { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: image.base64 } },
    { type: 'text' as const, text: prompt },
  ];
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

// --- Main exports ---

export async function generateText(opts: GenerateOptions): Promise<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { prompt, systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;

  if (model.provider === 'kie') {
    return kieGenerateText(opts.modelId, prompt, systemPrompt, maxTokens);
  }

  if (model.provider === 'perplexity') {
    const perplexityKey = await getPerplexityKey();
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
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
    const msgContent = buildAnthropicContent(prompt, opts.image);
    const response = await client.messages.create({
      model: model.id,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
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
    const msgs = buildOpenAIMessages(prompt, systemPrompt, opts.image);
    const response = await client.chat.completions.create({
      model: model.id,
      messages: msgs,
      max_tokens: maxTokens,
      temperature,
    });
    return response.choices[0].message.content || '';
  }

  if (model.provider === 'google') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    if (!process.env.GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY environment variable is not configured');
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    const gemini = genAI.getGenerativeModel({ model: model.id, generationConfig: { temperature, maxOutputTokens: maxTokens } });
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    if (opts.image) {
      const result = await gemini.generateContent([
        fullPrompt,
        { inlineData: { mimeType: opts.image.mimeType, data: opts.image.base64 } },
      ]);
      return result.response.text();
    }
    const result = await gemini.generateContent(fullPrompt);
    return result.response.text();
  }

  throw new Error(`Unsupported provider: ${model.provider}`);
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
      const errText = await res.text();
      throw new Error(`Kie.ai Gemini video error ${res.status}: ${errText}. Note: YouTube URL support via Kie.ai is undocumented — if this fails consistently, switch to a direct Google Gemini model.`);
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

  const { prompt, systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;

  if (model.provider === 'kie') {
    yield* kieStreamText(opts.modelId, prompt, systemPrompt, maxTokens);
    return;
  }

  if (model.provider === 'perplexity') {
    const perplexityKey = await getPerplexityKey();
    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
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
    const msgContent = buildAnthropicContent(prompt, opts.image);
    const stream = client.messages.stream({
      model: model.id,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
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
    const msgs = buildOpenAIMessages(prompt, systemPrompt, opts.image);
    const stream = await client.chat.completions.create({
      model: model.id,
      messages: msgs,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });
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
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
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
    return;
  }

  throw new Error(`Streaming not supported for provider: ${model.provider}`);
}
