// Server-only AI provider abstraction — supports Anthropic, OpenAI, Google
// Do NOT import this file from client components — import from ai-models.ts instead.

export type { AIProvider, AIModel } from './ai-models';
export { AI_MODELS, getDefaultModel, getModelById } from './ai-models';

import { getModelById } from './ai-models';

export interface GenerateOptions {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function generateText(opts: GenerateOptions): Promise<string> {
  const model = getModelById(opts.modelId);
  if (!model) throw new Error(`Unknown model: ${opts.modelId}`);

  const { prompt, systemPrompt, maxTokens = 4000, temperature = 0.7 } = opts;

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
