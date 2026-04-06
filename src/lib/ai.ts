// Server-only AI provider abstraction — supports Anthropic, OpenAI, Google, Kie.ai
// Do NOT import this file from client components — import from ai-models.ts instead.

export type { AIProvider, AIModel } from './ai-models';
export { AI_MODELS, getDefaultModel, getModelById } from './ai-models';

import { getModelById } from './ai-models';
import { KIE_MODEL_MAP } from './ai-models';

const KIE_BASE = 'https://api.kie.ai';

export interface GenerateOptions {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
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

// --- Main exports ---

export async function generateText(opts: GenerateOptions): Promise<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { prompt, systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;

  if (model.provider === 'kie') {
    return kieGenerateText(opts.modelId, prompt, systemPrompt, maxTokens);
  }

  if (model.provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: model.id,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type');
    return block.text;
  }

  if (model.provider === 'openai') {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const msgs: { role: 'system' | 'user'; content: string }[] = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: prompt });
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
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || '');
    const gemini = genAI.getGenerativeModel({ model: model.id });
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const result = await gemini.generateContent(fullPrompt);
    return result.response.text();
  }

  throw new Error(`Unsupported provider: ${model.provider}`);
}

// Streaming version for real-time UI updates
export async function* generateTextStream(opts: GenerateOptions): AsyncGenerator<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { prompt, systemPrompt, maxTokens = 4000 } = opts;

  if (model.provider === 'kie') {
    yield* kieStreamText(opts.modelId, prompt, systemPrompt, maxTokens);
    return;
  }

  if (model.provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream({
      model: model.id,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
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
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const msgs: { role: 'system' | 'user'; content: string }[] = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: prompt });
    const stream = await client.chat.completions.create({
      model: model.id,
      messages: msgs,
      max_tokens: maxTokens,
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
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || '');
    const gemini = genAI.getGenerativeModel({ model: model.id });
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const result = await gemini.generateContentStream(fullPrompt);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
    return;
  }

  throw new Error(`Streaming not supported for provider: ${model.provider}`);
}
