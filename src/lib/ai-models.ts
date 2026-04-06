// Client-safe AI model definitions (no server SDK imports)

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'kie';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: string;
  description: string;
  tier: 'flagship' | 'balanced' | 'fast';
}

// Features that support per-feature model selection
export type AppFeature = 'script-generator' | 'qa-engine' | 'idea-generator';

export const APP_FEATURES: { id: AppFeature; label: string; description: string }[] = [
  { id: 'script-generator', label: 'Script Generator', description: 'AI model used for generating YouTube scripts' },
  { id: 'qa-engine', label: 'QA Engine', description: 'AI model used for script quality analysis' },
  { id: 'idea-generator', label: 'Idea Generator', description: 'AI model used for brainstorming video ideas' },
];

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
  // Kie.ai — Gemini models
  { id: 'kie-gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'kie', contextWindow: '1M', description: 'Fast Gemini via Kie.ai — lower cost', tier: 'fast' },
  { id: 'kie-gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'kie', contextWindow: '1M', description: 'Advanced reasoning via Kie.ai', tier: 'flagship' },
  { id: 'kie-gemini-3-flash', name: 'Gemini 3 Flash', provider: 'kie', contextWindow: '1M', description: 'Latest fast Gemini via Kie.ai', tier: 'fast' },
  { id: 'kie-gemini-3-pro', name: 'Gemini 3 Pro', provider: 'kie', contextWindow: '1M', description: 'Latest pro Gemini via Kie.ai', tier: 'flagship' },
  { id: 'kie-gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'kie', contextWindow: '1M', description: 'Newest Gemini reasoning via Kie.ai', tier: 'flagship' },
  // Kie.ai — Claude models
  { id: 'kie-claude-opus-4-6', name: 'Claude Opus 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus via Kie.ai — lower cost', tier: 'flagship' },
  { id: 'kie-claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet via Kie.ai — lower cost', tier: 'balanced' },
  { id: 'kie-claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet 4.5 via Kie.ai', tier: 'balanced' },
  { id: 'kie-claude-opus-4-5', name: 'Claude Opus 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus 4.5 via Kie.ai', tier: 'flagship' },
  { id: 'kie-claude-haiku-4-5', name: 'Claude Haiku 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Haiku via Kie.ai — cheapest', tier: 'fast' },
  // Kie.ai — GPT models
  { id: 'kie-gpt-5-2', name: 'GPT 5.2 (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT 5.2 via Kie.ai', tier: 'balanced' },
  { id: 'kie-gpt-5-4', name: 'GPT 5.4 (Kie)', provider: 'kie', contextWindow: '200K', description: 'Latest GPT via Kie.ai — powerful reasoning', tier: 'flagship' },
];

// Kie.ai model ID mapping: our internal ID → kie.ai API model ID and endpoint type
export type KieEndpointType = 'gemini' | 'claude' | 'gpt-responses';

export interface KieModelConfig {
  kieModelId: string;
  endpointType: KieEndpointType;
}

export const KIE_MODEL_MAP: Record<string, KieModelConfig> = {
  'kie-gemini-2.5-flash': { kieModelId: 'gemini-2.5-flash', endpointType: 'gemini' },
  'kie-gemini-2.5-pro': { kieModelId: 'gemini-2.5-pro', endpointType: 'gemini' },
  'kie-gemini-3-flash': { kieModelId: 'gemini-3-flash', endpointType: 'gemini' },
  'kie-gemini-3-pro': { kieModelId: 'gemini-3-pro', endpointType: 'gemini' },
  'kie-gemini-3.1-pro': { kieModelId: 'gemini-3.1-pro', endpointType: 'gemini' },
  'kie-claude-opus-4-6': { kieModelId: 'claude-opus-4-6', endpointType: 'claude' },
  'kie-claude-sonnet-4-6': { kieModelId: 'claude-sonnet-4-6', endpointType: 'claude' },
  'kie-claude-sonnet-4-5': { kieModelId: 'claude-sonnet-4-5', endpointType: 'claude' },
  'kie-claude-opus-4-5': { kieModelId: 'claude-opus-4-5', endpointType: 'claude' },
  'kie-claude-haiku-4-5': { kieModelId: 'claude-haiku-4-5', endpointType: 'claude' },
  'kie-gpt-5-2': { kieModelId: 'gpt-5-2', endpointType: 'gemini' }, // GPT 5.2 uses chat/completions
  'kie-gpt-5-4': { kieModelId: 'gpt-5-4', endpointType: 'gpt-responses' },
};

export function getDefaultModel(): AIModel {
  return AI_MODELS[0];
}

export function getModelById(id: string): AIModel | undefined {
  return AI_MODELS.find(m => m.id === id);
}

/** Get the saved default model ID for a feature, falling back to global default */
export function getFeatureDefaultModelId(feature: AppFeature): string {
  if (typeof window === 'undefined') return AI_MODELS[0].id;
  try {
    const saved = localStorage.getItem('feature_model_defaults');
    if (saved) {
      const defaults = JSON.parse(saved);
      if (defaults[feature] && getModelById(defaults[feature])) return defaults[feature];
    }
  } catch {}
  return AI_MODELS[0].id;
}
