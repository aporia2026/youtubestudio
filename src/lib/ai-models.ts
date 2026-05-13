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

// Sidebar sections that group features. Order matches the sidebar.
export type FeatureSection = 'create' | 'grow' | 'collaborate' | 'automate' | 'foundation';

export const FEATURE_SECTIONS: { id: FeatureSection; label: string; description: string }[] = [
  { id: 'create', label: 'Create', description: 'Script writing, QA, narration, video, and assets' },
  { id: 'grow', label: 'Grow', description: 'Channel insights, competitor intel, and growth tools' },
  { id: 'collaborate', label: 'Collaborate', description: 'Reviews and team coordination (no AI today)' },
  { id: 'automate', label: 'Automate', description: 'Workflows and Ask Studio' },
  { id: 'foundation', label: 'Foundation', description: 'Cross-cutting helpers: scheduling, formatting, etc.' },
];

// Features that support per-feature model selection. Every server-side
// generateText caller should map to exactly one feature here so the
// resolver can apply per-workspace overrides consistently.
export type AppFeature =
  // Create
  | 'script-generator'
  | 'qa-engine'
  | 'critic-panel'
  | 'idea-generator'
  | 'production-doc'
  | 'seo-optimizer'
  | 'youtube-description'
  | 'thumbnail-generate'
  | 'image-style-analyze'
  | 'narrator-split-sections'
  | 'script-format'
  | 'dubbing-translate'
  | 'shorts-extract'
  | 'video-composer'
  // Grow
  | 'channel-analyze'
  | 'channel-naming'
  | 'competitor-analysis'
  | 'competitor-ideas'
  | 'competitor-thumbnail'
  | 'youtube-analyze'
  | 'retention-predictor'
  | 'fix-the-dip'
  | 'cannibalization'
  | 'comment-triage'
  | 'seo-title-rewrite'
  | 'video-format-tagger'
  | 'weekly-insight-digest'
  | 'niche-cluster-map'
  | 'niche-deep-dive'
  | 'niche-taxonomy-generate'
  | 'niche-favorite-brief'
  // Automate
  | 'ask-studio'
  // Foundation
  | 'schedule-suggest'
  | 'schedule-title';

export interface AppFeatureSpec {
  id: AppFeature;
  label: string;
  description: string;
  section: FeatureSection;
  /** Hardcoded fallback model — used when no workspace/section/feature
   *  override is set. Picked per feature based on quality/cost tradeoff. */
  defaultModelId: string;
}

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const KIE_GEMINI_FLASH = 'kie-gemini-2.5-flash';

export const APP_FEATURES: AppFeatureSpec[] = [
  // ─── Create ──────────────────────────────────────────────────────────
  { id: 'script-generator', label: 'Script Generator', description: 'Drafts YouTube scripts from a brief', section: 'create', defaultModelId: SONNET },
  { id: 'qa-engine', label: 'QA Engine', description: 'Single-model script quality analysis', section: 'create', defaultModelId: SONNET },
  { id: 'critic-panel', label: 'Critic Panel', description: 'Multi-critic deliberative script review (charter → drafts → deliberation → chair)', section: 'create', defaultModelId: SONNET },
  { id: 'idea-generator', label: 'Idea Generator', description: 'Brainstorms video ideas for a niche', section: 'create', defaultModelId: SONNET },
  { id: 'production-doc', label: 'Production Document', description: 'Shot-by-shot production plan from a script', section: 'create', defaultModelId: SONNET },
  { id: 'seo-optimizer', label: 'SEO Optimizer', description: 'Optimizes titles, descriptions, and tags', section: 'create', defaultModelId: SONNET },
  { id: 'youtube-description', label: 'YouTube Description', description: 'Generates the description / chapter list / tags for a script', section: 'create', defaultModelId: HAIKU },
  { id: 'thumbnail-generate', label: 'Thumbnail Generator', description: 'Drafts thumbnail concepts + copy variants', section: 'create', defaultModelId: SONNET },
  { id: 'image-style-analyze', label: 'Image Style Analyze', description: 'Reads a thumbnail image and extracts style/composition', section: 'create', defaultModelId: HAIKU },
  { id: 'narrator-split-sections', label: 'Narrator — Split Sections', description: 'Splits a long script into narrator-friendly sections', section: 'create', defaultModelId: HAIKU },
  { id: 'script-format', label: 'Script Format (ElevenLabs)', description: 'Reformats a script for ElevenLabs voiceover ingestion', section: 'create', defaultModelId: KIE_GEMINI_FLASH },
  { id: 'dubbing-translate', label: 'Dubbing — Translate', description: 'Translates a script for an auto-dub', section: 'create', defaultModelId: HAIKU },
  { id: 'shorts-extract', label: 'Shorts Extract', description: 'Extracts shorts-worthy moments from a long script', section: 'create', defaultModelId: SONNET },
  { id: 'video-composer', label: 'Video Composer', description: 'Composer pipeline (intake → analyze → plan → compose → critic → chair)', section: 'create', defaultModelId: SONNET },

  // ─── Grow ────────────────────────────────────────────────────────────
  { id: 'channel-analyze', label: 'Channel Analyze', description: 'Analyzes a YouTube channel for positioning + opportunities', section: 'grow', defaultModelId: SONNET },
  { id: 'channel-naming', label: 'Channel Naming', description: 'Generates brandable channel names + @handles', section: 'grow', defaultModelId: SONNET },
  { id: 'competitor-analysis', label: 'Competitor Analysis', description: 'Deep competitor intelligence + content patterns', section: 'grow', defaultModelId: SONNET },
  { id: 'competitor-ideas', label: 'Competitor Ideas', description: 'Generates ideas inspired by a competitor channel', section: 'grow', defaultModelId: SONNET },
  { id: 'competitor-thumbnail', label: 'Competitor Thumbnail', description: 'Analyzes a competitor thumbnail for what works', section: 'grow', defaultModelId: HAIKU },
  { id: 'youtube-analyze', label: 'YouTube Analyze', description: 'Analyzes channel/video analytics for insights', section: 'grow', defaultModelId: SONNET },
  { id: 'retention-predictor', label: 'Retention Predictor', description: 'Predicts retention curves for a script', section: 'grow', defaultModelId: HAIKU },
  { id: 'fix-the-dip', label: 'Fix the Dip', description: 'Diagnoses retention dips and suggests rewrites', section: 'grow', defaultModelId: SONNET },
  { id: 'cannibalization', label: 'Cannibalization', description: 'Finds videos competing with each other for the same query', section: 'grow', defaultModelId: HAIKU },
  { id: 'comment-triage', label: 'Comment Triage', description: 'Sorts comments by signal: questions, bugs, ideas, hate', section: 'grow', defaultModelId: HAIKU },
  { id: 'seo-title-rewrite', label: 'SEO Title Rewrite', description: 'Rewrites a title to capture missed search demand from underperforming queries', section: 'grow', defaultModelId: SONNET },
  { id: 'video-format-tagger', label: 'Video Format Tagger', description: 'Auto-classifies a video by format + topic for attribution analytics', section: 'grow', defaultModelId: HAIKU },
  { id: 'weekly-insight-digest', label: 'Weekly Insight Digest', description: 'Synthesises week-over-week analytics into a 1-page Monday digest', section: 'grow', defaultModelId: SONNET },
  { id: 'niche-cluster-map', label: 'Niche Finder — Cluster Map', description: 'Groups harvested search terms into concept clusters for niche discovery', section: 'grow', defaultModelId: HAIKU },
  { id: 'niche-deep-dive', label: 'Niche Finder — Deep Dive Memo', description: 'Writes the strategy memo for a scored niche', section: 'grow', defaultModelId: SONNET },
  { id: 'niche-taxonomy-generate', label: 'Niche Finder — Taxonomy Expansion', description: 'Brainstorms monetization-tilted sub-niches and micro-niches under a parent category', section: 'grow', defaultModelId: 'kie-gemini-3-pro' },
  { id: 'niche-favorite-brief', label: 'Niche Finder — Favorite Brief', description: 'Writes the operator-grounded promise memo for a favorited niche (demand, competition, monetization, fit, risks, recommended angle)', section: 'grow', defaultModelId: 'sonar-deep-research' },

  // ─── Automate ────────────────────────────────────────────────────────
  { id: 'ask-studio', label: 'Ask Studio', description: 'Conversational analytics — natural-language questions over your channel data', section: 'automate', defaultModelId: HAIKU },

  // ─── Foundation ──────────────────────────────────────────────────────
  { id: 'schedule-suggest', label: 'Schedule — "What next" suggestions', description: 'Picks the next video from backlog + ideas', section: 'foundation', defaultModelId: SONNET },
  { id: 'schedule-title', label: 'Schedule — Title candidates from script', description: 'Generates YouTube title candidates from a linked script', section: 'foundation', defaultModelId: HAIKU },
];

/** Lookup a feature spec by id. Returns undefined for unknown ids. */
export function getFeatureSpec(id: AppFeature): AppFeatureSpec | undefined {
  return APP_FEATURES.find((f) => f.id === id);
}

export const AI_MODELS: AIModel[] = [
  // Anthropic
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Most capable — best for complex analysis', tier: 'flagship', inputCostPerMTok: 15, outputCostPerMTok: 75 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: '1M', description: 'Balanced speed & quality', tier: 'balanced', inputCostPerMTok: 3, outputCostPerMTok: 15 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: '1M', description: 'Fast & cost-effective', tier: 'fast', inputCostPerMTok: 1, outputCostPerMTok: 5 },
  // OpenAI — pricing from openai.com/api/pricing as of 2025-2026; verify per-call.
  //
  // GPT-5.5 family (newest) — listed first so it's the obvious pick. Pricing
  // is approximate (extrapolated from the GPT-5 launch values); the registry
  // displays a pricingNote so users know to verify before relying on numbers.
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', contextWindow: '400K', description: 'Newest OpenAI flagship — strongest general model', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 12, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini', provider: 'openai', contextWindow: '400K', description: 'Newest mid-tier — cheaper, near-flagship quality', tier: 'balanced', inputCostPerMTok: 0.3, outputCostPerMTok: 2.4, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.5-nano', name: 'GPT-5.5 Nano', provider: 'openai', contextWindow: '400K', description: 'Newest fast tier — high-volume, low-latency work', tier: 'fast', inputCostPerMTok: 0.07, outputCostPerMTok: 0.5, pricingNote: 'verify on openai.com/api/pricing' },
  // GPT-5.4 / 5.3 / 5.2 / 5.1 — successive iterative releases between
  // GPT-5 (Aug 2025) and GPT-5.5. Most users will pick 5.5 or one of these
  // depending on cost/latency targets. Identical context to the GPT-5 family.
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextWindow: '400K', description: 'GPT-5.4 flagship', tier: 'flagship', inputCostPerMTok: 1.4, outputCostPerMTok: 11, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', contextWindow: '400K', description: 'GPT-5.4 mid-tier', tier: 'balanced', inputCostPerMTok: 0.28, outputCostPerMTok: 2.2, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai', contextWindow: '400K', description: 'GPT-5.4 fast tier', tier: 'fast', inputCostPerMTok: 0.06, outputCostPerMTok: 0.45, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.3', name: 'GPT-5.3', provider: 'openai', contextWindow: '400K', description: 'GPT-5.3 flagship', tier: 'flagship', inputCostPerMTok: 1.35, outputCostPerMTok: 10.5, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.3-mini', name: 'GPT-5.3 Mini', provider: 'openai', contextWindow: '400K', description: 'GPT-5.3 mid-tier', tier: 'balanced', inputCostPerMTok: 0.27, outputCostPerMTok: 2.1, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.3-nano', name: 'GPT-5.3 Nano', provider: 'openai', contextWindow: '400K', description: 'GPT-5.3 fast tier', tier: 'fast', inputCostPerMTok: 0.06, outputCostPerMTok: 0.43, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', contextWindow: '400K', description: 'GPT-5.2 flagship', tier: 'flagship', inputCostPerMTok: 1.3, outputCostPerMTok: 10.25, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.2-mini', name: 'GPT-5.2 Mini', provider: 'openai', contextWindow: '400K', description: 'GPT-5.2 mid-tier', tier: 'balanced', inputCostPerMTok: 0.26, outputCostPerMTok: 2.05, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.2-nano', name: 'GPT-5.2 Nano', provider: 'openai', contextWindow: '400K', description: 'GPT-5.2 fast tier', tier: 'fast', inputCostPerMTok: 0.05, outputCostPerMTok: 0.42, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.1', name: 'GPT-5.1', provider: 'openai', contextWindow: '400K', description: 'GPT-5.1 flagship', tier: 'flagship', inputCostPerMTok: 1.28, outputCostPerMTok: 10.1, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.1-mini', name: 'GPT-5.1 Mini', provider: 'openai', contextWindow: '400K', description: 'GPT-5.1 mid-tier', tier: 'balanced', inputCostPerMTok: 0.25, outputCostPerMTok: 2.02, pricingNote: 'verify on openai.com/api/pricing' },
  { id: 'gpt-5.1-nano', name: 'GPT-5.1 Nano', provider: 'openai', contextWindow: '400K', description: 'GPT-5.1 fast tier', tier: 'fast', inputCostPerMTok: 0.05, outputCostPerMTok: 0.41, pricingNote: 'verify on openai.com/api/pricing' },
  // GPT-5 family (original, released Aug 2025)
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', contextWindow: '400K', description: 'Original GPT-5 flagship', tier: 'flagship', inputCostPerMTok: 1.25, outputCostPerMTok: 10 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai', contextWindow: '400K', description: 'Cheaper GPT-5 with most of the smarts', tier: 'balanced', inputCostPerMTok: 0.25, outputCostPerMTok: 2 },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', provider: 'openai', contextWindow: '400K', description: 'Fast & cheap GPT-5 — high-volume work', tier: 'fast', inputCostPerMTok: 0.05, outputCostPerMTok: 0.4 },
  // GPT-4.1 family (released April 2025) — strong general models, 1M context
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', contextWindow: '1M', description: 'Strong general model — 1M context, great instruction following', tier: 'flagship', inputCostPerMTok: 2, outputCostPerMTok: 8 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai', contextWindow: '1M', description: 'Mid-tier 4.1 — good balance', tier: 'balanced', inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'openai', contextWindow: '1M', description: 'Cheapest 4.1 — high volume', tier: 'fast', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  // GPT-4o (legacy multimodal) — kept for compatibility with older saved settings
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: '128K', description: 'Legacy multimodal — superseded by GPT-5', tier: 'balanced', inputCostPerMTok: 2.5, outputCostPerMTok: 10 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: '128K', description: 'Legacy — superseded by GPT-5 Mini', tier: 'fast', inputCostPerMTok: 0.15, outputCostPerMTok: 0.6 },
  // o-series reasoning models — use max_completion_tokens, fixed temperature.
  // The provider branch in ai.ts auto-detects these via model.id prefix.
  { id: 'o3', name: 'o3', provider: 'openai', contextWindow: '200K', description: 'Best general reasoning model', tier: 'flagship', inputCostPerMTok: 2, outputCostPerMTok: 8 },
  { id: 'o3-mini', name: 'o3 Mini', provider: 'openai', contextWindow: '200K', description: 'Cheap reasoning — good for QA / analysis', tier: 'balanced', inputCostPerMTok: 1.1, outputCostPerMTok: 4.4 },
  { id: 'o4-mini', name: 'o4 Mini', provider: 'openai', contextWindow: '200K', description: 'Newer compact reasoning model', tier: 'balanced', inputCostPerMTok: 1.1, outputCostPerMTok: 4.4 },
  // Google — pricing for 3.x is approximate; verify on https://ai.google.dev/pricing
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', contextWindow: '1M', description: 'Fast & capable — supports native video input', tier: 'balanced', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking', provider: 'google', contextWindow: '1M', description: 'Reasoning model — supports native video input', tier: 'flagship', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: '1M', description: 'Latest fast Gemini — native video input', tier: 'balanced', inputCostPerMTok: 0.075, outputCostPerMTok: 0.3, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', contextWindow: '1M', description: 'Advanced reasoning Gemini — native video input', tier: 'flagship', inputCostPerMTok: 1.25, outputCostPerMTok: 5, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash (unverified)', provider: 'google', contextWindow: '1M', description: 'Not on Google v1beta yet — picks return 404. Use kie-gemini-3-flash to route through Kie.ai instead.', tier: 'fast', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro (unverified)', provider: 'google', contextWindow: '1M', description: 'Not on Google v1beta yet — picks return 404. Use kie-gemini-3-pro to route through Kie.ai instead.', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'verify on ai.google.dev' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro (unverified)', provider: 'google', contextWindow: '1M', description: 'Not on Google v1beta yet — picks return 404. Use kie-gemini-3.1-pro to route through Kie.ai instead.', tier: 'flagship', inputCostPerMTok: 1.5, outputCostPerMTok: 6, pricingNote: 'verify on ai.google.dev' },
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
  { id: 'kie-claude-opus-4-7', name: 'Claude Opus 4.7 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Newest Anthropic flagship via Kie.ai', tier: 'flagship', inputCostPerMTok: 12, outputCostPerMTok: 60, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-opus-4-6', name: 'Claude Opus 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus via Kie.ai', tier: 'flagship', inputCostPerMTok: 12, outputCostPerMTok: 60, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet via Kie.ai', tier: 'balanced', inputCostPerMTok: 2.4, outputCostPerMTok: 12, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Sonnet 4.5 via Kie.ai', tier: 'balanced', inputCostPerMTok: 2.4, outputCostPerMTok: 12, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-opus-4-5', name: 'Claude Opus 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Opus 4.5 via Kie.ai', tier: 'flagship', inputCostPerMTok: 12, outputCostPerMTok: 60, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-claude-haiku-4-5', name: 'Claude Haiku 4.5 (Kie)', provider: 'kie', contextWindow: '1M', description: 'Claude Haiku via Kie.ai', tier: 'fast', inputCostPerMTok: 0.8, outputCostPerMTok: 4, pricingNote: 'approx — verify on kie.ai' },
  // Kie.ai — GPT models (chat/completions + Codex Responses API)
  { id: 'kie-gpt-5-2', name: 'GPT 5.2 (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT 5.2 via Kie.ai', tier: 'balanced', inputCostPerMTok: 2, outputCostPerMTok: 8, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-4', name: 'GPT 5.4 (Kie)', provider: 'kie', contextWindow: '200K', description: 'Latest GPT via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-5', name: 'GPT 5.5 (Kie)', provider: 'kie', contextWindow: '200K', description: 'Newest OpenAI flagship via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  // Kie.ai — GPT Codex variants (coding-focused, Responses API at /api/v1/responses)
  { id: 'kie-gpt-5-codex', name: 'GPT-5 Codex (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT-5 Codex — coding-focused via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-1-codex', name: 'GPT-5.1 Codex (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT-5.1 Codex via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-2-codex', name: 'GPT-5.2 Codex (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT-5.2 Codex via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-3-codex', name: 'GPT-5.3 Codex (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT-5.3 Codex via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
  { id: 'kie-gpt-5-4-codex', name: 'GPT-5.4 Codex (Kie)', provider: 'kie', contextWindow: '200K', description: 'GPT-5.4 Codex via Kie.ai', tier: 'flagship', inputCostPerMTok: 4, outputCostPerMTok: 16, pricingNote: 'approx — verify on kie.ai' },
];

// Kie.ai model ID mapping: our internal ID → kie.ai API model ID and endpoint type
//
// Endpoint types:
//   gemini          → POST /<kieModelId>/v1/chat/completions  (OpenAI-compatible chat)
//   claude          → POST /claude/v1/messages                 (Anthropic-style)
//   gpt-responses   → POST /codex/v1/responses                 (gpt-5-2/4/5 — uses `input` not messages)
//   codex-responses → POST /api/v1/responses                   (gpt-5-N-codex variants — same shape as gpt-responses)
export type KieEndpointType = 'gemini' | 'claude' | 'gpt-responses' | 'codex-responses';

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
  'kie-claude-opus-4-7': { kieModelId: 'claude-opus-4-7', endpointType: 'claude' },
  'kie-claude-opus-4-6': { kieModelId: 'claude-opus-4-6', endpointType: 'claude' },
  'kie-claude-sonnet-4-6': { kieModelId: 'claude-sonnet-4-6', endpointType: 'claude' },
  'kie-claude-sonnet-4-5': { kieModelId: 'claude-sonnet-4-5', endpointType: 'claude' },
  'kie-claude-opus-4-5': { kieModelId: 'claude-opus-4-5', endpointType: 'claude' },
  'kie-claude-haiku-4-5': { kieModelId: 'claude-haiku-4-5', endpointType: 'claude' },
  'kie-gpt-5-2': { kieModelId: 'gpt-5-2', endpointType: 'gemini' }, // GPT 5.2 uses chat/completions
  'kie-gpt-5-4': { kieModelId: 'gpt-5-4', endpointType: 'gpt-responses' },
  'kie-gpt-5-5': { kieModelId: 'gpt-5-5', endpointType: 'gpt-responses' }, // also /codex/v1/responses
  'kie-gpt-5-codex': { kieModelId: 'gpt-5-codex', endpointType: 'codex-responses' },
  'kie-gpt-5-1-codex': { kieModelId: 'gpt-5.1-codex', endpointType: 'codex-responses' },
  'kie-gpt-5-2-codex': { kieModelId: 'gpt-5.2-codex', endpointType: 'codex-responses' },
  'kie-gpt-5-3-codex': { kieModelId: 'gpt-5.3-codex', endpointType: 'codex-responses' },
  'kie-gpt-5-4-codex': { kieModelId: 'gpt-5.4-codex', endpointType: 'codex-responses' },
};

/**
 * Default fallback chains per feature, used by the auto-pipeline
 * orchestrator and `generateTextWithFallback`. Each chain is an
 * ordered list: try the first model; on a transient failure
 * (5xx / rate-limit / timeout / empty/malformed response) move to
 * the next; on a content refusal or unclassified failure, surface
 * the error instead of falling through (refusal is a content signal,
 * not a transient error — fallback would ship content the primary
 * model declined to produce).
 *
 * Strategy: cross-provider primary → cross-provider backup → same-model
 * via alternate route (Kie) for resilience to upstream-provider
 * outages. The user can override this entirely per
 * `pipeline_presets.fallback_chains_jsonb`; this registry is the
 * out-of-the-box default when no override exists.
 *
 * v1 wires the chains into the four auto-pipeline features only.
 * Other features keep the single-model behaviour from Phase 6.2
 * until a future ticket retrofits them.
 *
 * Model ids must exist in `AI_MODELS`. The orchestrator validates
 * via `getModelById` before each attempt and skips unknown entries.
 */
export const DEFAULT_FALLBACK_CHAINS: Partial<Record<AppFeature, string[]>> = {
  // Idea brainstorming: needs decent capability but fires N times per
  // batch; Haiku as last-resort fallback keeps cost bounded when both
  // flagship providers are down.
  'idea-generator': ['claude-sonnet-4-6', 'gpt-5.5-mini', 'claude-haiku-4-5-20251001'],

  // Script gen: the most quality-sensitive call. Cross-provider
  // backup, then same Sonnet via Kie as alternate route. No Haiku
  // tier — a degraded script defeats the point of QA-looping it.
  'script-generator': ['claude-sonnet-4-6', 'gpt-5.5', 'kie-claude-sonnet-4-6'],

  // Critic panel: multi-call deliberation. Same chain as script-gen —
  // critics scoring against a Haiku-grade script would skew low and
  // burn the QA loop on noise.
  'critic-panel': ['claude-sonnet-4-6', 'gpt-5.5', 'kie-claude-sonnet-4-6'],

  // Production doc: structured JSON output, cost-sensitive when each
  // row is its own call. Same flagship chain — Haiku-tier models
  // routinely break the row schema.
  'production-doc': ['claude-sonnet-4-6', 'gpt-5.5', 'kie-claude-sonnet-4-6'],

  // SEO optimizer: produces titles + description + tags + chapters
  // in a single JSON pass. Mid-pipeline, runs after the editor
  // handoff. Same flagship chain — title quality is the gatekeeper
  // metric and Haiku-tier models routinely emit shorter / less
  // optimised candidates.
  'seo-optimizer': ['claude-sonnet-4-6', 'gpt-5.5', 'kie-claude-sonnet-4-6'],
};

/** Lookup the configured fallback chain for a feature, or `null` when
 *  no chain is registered. The caller decides what to do with `null`
 *  — single-shot callers fall back to `resolveFeatureModelId`. */
export function getDefaultFallbackChain(feature: AppFeature): readonly string[] | null {
  return DEFAULT_FALLBACK_CHAINS[feature] ?? null;
}

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

/** Resolve a feature's default model from a defaults blob using the
 *  workspace → section → feature precedence. Pure function — both the
 *  client and the server use this against their respective sources of
 *  truth (a fetched JSON blob on the client, the DB on the server). */
export function resolveFeatureModelId(
  feature: AppFeature,
  defaults: { workspace?: string | null; sections?: Partial<Record<FeatureSection, string | null>>; features?: Partial<Record<AppFeature, string | null>> } | null | undefined,
): string {
  const spec = getFeatureSpec(feature);
  // 1. Per-feature override wins.
  const featureOverride = defaults?.features?.[feature];
  if (featureOverride && getModelById(featureOverride)) return featureOverride;
  // 2. Per-section override.
  if (spec) {
    const sectionOverride = defaults?.sections?.[spec.section];
    if (sectionOverride && getModelById(sectionOverride)) return sectionOverride;
  }
  // 3. Workspace-wide override.
  const workspaceOverride = defaults?.workspace;
  if (workspaceOverride && getModelById(workspaceOverride)) return workspaceOverride;
  // 4. Feature's hardcoded default.
  if (spec && getModelById(spec.defaultModelId)) return spec.defaultModelId;
  // 5. Last-ditch: first registered model.
  return AI_MODELS[0].id;
}

export interface ModelDefaultsBlob {
  workspace: string | null;
  sections: Partial<Record<FeatureSection, string | null>>;
  features: Partial<Record<AppFeature, string | null>>;
}

/** Get the saved default model ID for a feature on the client, falling
 *  back through the documented precedence to the feature's hardcoded
 *  default. Reads from localStorage when no fetched-from-server blob is
 *  passed. Server callers must use `getEffectiveModelId` from
 *  `model-defaults.ts` instead — this function CANNOT see the DB. */
export function getFeatureDefaultModelId(
  feature: AppFeature,
  blob?: ModelDefaultsBlob | null,
): string {
  if (blob) return resolveFeatureModelId(feature, blob);
  if (typeof window === 'undefined') {
    return getFeatureSpec(feature)?.defaultModelId ?? AI_MODELS[0].id;
  }
  try {
    const saved = localStorage.getItem('feature_model_defaults_v2');
    if (saved) {
      return resolveFeatureModelId(feature, JSON.parse(saved) as ModelDefaultsBlob);
    }
  } catch {}
  return getFeatureSpec(feature)?.defaultModelId ?? AI_MODELS[0].id;
}
