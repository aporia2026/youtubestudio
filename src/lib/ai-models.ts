// Client-safe AI model definitions (no server SDK imports)

export type AIProvider = 'anthropic' | 'openai' | 'google' | 'kie' | 'perplexity';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: string;
  description: string;
  tier: 'flagship' | 'balanced' | 'fast';
  /** Cost per 1M input tokens in USD */
  inputCostPerMTok: number;
  /** Cost per 1M output tokens in USD */
  outputCostPerMTok: number;
  /** Extra notes on pricing (e.g. per-search fees for Perplexity) */
  pricingNote?: string;
  /** Does this model perform live web search? */
  webSearch?: boolean;
}

// Features that support per-feature model selection
export type AppFeature = 'script-generator' | 'qa-engine' | 'idea-generator' | 'competitor-analysis';

export const APP_FEATURES: { id: AppFeature; label: string; description: string }[] = [
  { id: 'script-generator', label: 'Script Generator', description: 'AI model used for generating YouTube scripts' },
  { id: 'qa-engine', label: 'QA Engine', description: 'AI model used for script quality analysis' },
  { id: 'idea-generator', label: 'Idea Generator', description: 'AI model used for brainstorming video ideas' },
  { id: 'competitor-analysis', label: 'Competitor Analysis', description: 'AI model used for deep competitor intelligence' },
];

export const AI_MODELS: AIModel[] = [
  // Anthropic
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Most capable — best for complex analysis', tier: 'flagship', inputCostPerMTok: 15, outputCostPerMTok: 75 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Balanced speed & quality', tier: 'balanced', inputCostPerMTok: 3, outputCostPerMTok: 15 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: '1M', description: 'Fast & cost-effective', tier: 'fast', inputCostPerMTok: 1, outputCostPerMTok: 5 },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: '128K', description: 'OpenAI flagship multimodal', tier: 'flagship', inputCostPerMTok: 2.5, outputCostPerMTok: 10 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: '128K', description: 'Fast & affordable OpenAI', tier: 'fast', inputCostPerMTok: 0.15, outputCostPerMTok: 0.6 },
  { id: 'o3', name: 'o3', provider: 'openai', contextWindow: '200K', description: 'Best reasoning model', tier: 'flagship', inputCostPerMTok: 2, outputCostPerMTok: 8 },
  // Google — pricing for 3.x is approximate; verify on https://ai.google.dev/pricing
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', contextWindow: '1M', description: 'Fast & capable — supports native video input', tier: 'balanced', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking', provider: 'google', contextWindow: '1M', description: 'Reasoning model — supports native video input', tier: 'flagship', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: '1M', description: 'Latest fast Gemini — native video input', tier: 'balanced', inputCostPerMTok: 0.075, outputCostPerMTok: 0.3, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', contextWindow: '1M', description: 'Advanced reasoning Gemini — native video input', tier: 'flagship', inputCostPerMTok: 1.25, outputCostPerMTok: 5, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google', contextWindow: '1M', description: 'Gemini 3 fast tier — native video input', tier: 'fast', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google', contextWindow: '1M', description: 'Gemini 3 flagship — native video input', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google', contextWindow: '1M', description: 'Gemini 3.1 — best reasoning + native video input', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'verify on ai.google.dev' },
  // Perplexity — all sonar models (web-search powered)
  { id: 'sonar', name: 'Perplexity Sonar', provider: 'perplexity', contextWindow: '128K', description: 'Fast web search — grounded answers', tier: 'fast', inputCostPerMTok: 1, outputCostPerMTok: 1, pricingNote: '+ $5 per 1,000 searches', webSearch: true },
  { id: 'sonar-pro', name: 'Perplexity Sonar Pro', provider: 'perplexity', contextWindow: '200K', description: 'Advanced web search — deeper citations', tier: 'balanced', inputCostPerMTok: 3, outputCostPerMTok: 15, pricingNote: '+ $5 per 1,000 searches', webSearch: true },
  { id: 'sonar-reasoning', name: 'Perplexity Sonar Reasoning', provider: 'perplexity', contextWindow: '128K', description: 'Chain-of-thought + web search', tier: 'balanced', inputCostPerMTok: 1, outputCostPerMTok: 5, pricingNote: '+ $5 per 1,000 searches', webSearch: true },
  { id: 'sonar-reasoning-pro', name: 'Perplexity Sonar Reasoning Pro', provider: 'perplexity', contextWindow: '128K', description: 'Premium reasoning + web search', tier: 'flagship', inputCostPerMTok: 2, outputCostPerMTok: 8, pricingNote: '+ $5 per 1,000 searches', webSearch: true },
  { id: 'sonar-deep-research', name: 'Perplexity Sonar Deep Research', provider: 'perplexity', contextWindow: '128K', description: 'Exhaustive multi-step research', tier: 'flagship', inputCostPerMTok: 2, outputCostPerMTok: 8, pricingNote: '+ $3/M reasoning tokens, + $5 per 1,000 searches', webSearch: true },
  // Kie.ai — Gemini models. Pricing is approximate based on Kie's published rate cards;
  // verify on https://kie.ai/pricing before relying on costs in production budgeting.
  { id: 'kie-gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'kie', contextWindow: '1M', description: 'Fast Gemini via Kie.ai', tier: 'fast', inputCostPerMTok: 0.075, outputCostPerMTok: 0.3, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'kie', contextWindow: '1M', description: 'Advanced reasoning via Kie.ai', tier: 'flagship', inputCostPerMTok: 1.25, outputCostPerMTok: 5, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gemini-3-flash', name: 'Gemini 3 Flash', provider: 'kie', contextWindow: '1M', description: 'Latest fast Gemini via Kie.ai', tier: 'fast', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gemini-3-pro', name: 'Gemini 3 Pro', provider: 'kie', contextWindow: '1M', description: 'Latest pro Gemini via Kie.ai', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'kie', contextWindow: '1M', description: 'Newest Gemini reasoning via Kie.ai', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'approx — verify on kie.ai' },
  // Kie.ai — Claude models
  { id: 'kie-claude-opus-4-6', name: 'Claude Opus 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus via Kie.ai', tier: 'flagship', inputCostPerMTok: 12, outputCostPerMTok: 60, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet via Kie.ai', tier: 'balanced', inputCostPerMTok: 2.4, outputCostPerMTok: 12, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet 4.5 via Kie.ai', tier: 'balanced', inputCostPerMTok: 2.4, outputCostPerMTok: 12, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-opus-4-5', name: 'Claude Opus 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus 4.5 via Kie.ai', tier: 'flagship', inputCostPerMTok: 12, outputCostPerMTok: 60, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-haiku-4-5', name: 'Claude Haiku 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Haiku via Kie.ai', tier: 'fast', inputCostPerMTok: 0.8, outputCostPerMTok: 4, pricingNote: 'approx — verify on kie.ai' },
  // Kie.ai — GPT models
  { id: 'kie-gpt-5-2', name: 'GPT 5.2 (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT 5.2 via Kie.ai', tier: 'balanced', inputCostPerMTok: 2, outputCostPerMTok: 8, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-4', name: 'GPT 5.4 (Kie)', provider: 'kie', contextWindow: '200K', description: 'Latest GPT via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
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

/** Format a model's pricing as a short, human-readable string. */
export function formatModelPricing(m: AIModel): string {
  const fmt = (n: number) => n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
  return `${fmt(m.inputCostPerMTok)} in / ${fmt(m.outputCostPerMTok)} out per 1M tok`;
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
