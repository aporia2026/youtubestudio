// Client-safe AI model definitions (no server SDK imports)

export type AIProvider = 'anthropic' | 'openai' | 'google';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: string;
  description: string;
  tier: 'flagship' | 'balanced' | 'fast';
}

export const AI_MODELS: AIModel[] = [
  // Anthropic
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Most capable — best for complex scripts', tier: 'flagship' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Balanced speed & quality', tier: 'balanced' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: '1M', description: 'Fast & cost-effective', tier: 'fast' },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: '128K', description: 'OpenAI flagship multimodal', tier: 'flagship' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: '128K', description: 'Fast & affordable OpenAI', tier: 'fast' },
  { id: 'o3', name: 'o3', provider: 'openai', contextWindow: '200K', description: 'Best reasoning model', tier: 'flagship' },
  // Google
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', contextWindow: '1M', description: 'Google fast & capable', tier: 'balanced' },
  { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking', provider: 'google', contextWindow: '1M', description: 'Google reasoning model', tier: 'flagship' },
];

export function getDefaultModel(): AIModel {
  return AI_MODELS[0];
}

export function getModelById(id: string): AIModel | undefined {
  return AI_MODELS.find(m => m.id === id);
}
