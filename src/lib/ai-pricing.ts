/**
 * AI model pricing registry. Cost is computed at log time from these
 * rates so historical rows freeze whatever pricing applied — re-pricing
 * later is a deliberate recompute pass, never a silent in-place mutation.
 *
 * Rates are USD per 1,000,000 tokens (in / out). Cached input is billed
 * at the discounted rate when present.
 *
 * Pricing snapshots reflect public Anthropic / OpenAI / Google rate
 * cards as of May 2026. Some rates (Kie market models) are
 * approximations of the underlying model — Kie wraps prices into their
 * own per-call markup, so spend numbers for Kie-routed models are
 * directional, not penny-precise.
 */

export type AiProvider = 'anthropic' | 'openai' | 'google' | 'kie' | 'elevenlabs' | 'unknown';

export interface AiModelPricing {
  /** Match key. May be the canonical model id OR a prefix used by `findPricing`. */
  match: string;
  matchKind: 'exact' | 'prefix';
  provider: AiProvider;
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cached input tokens (Anthropic). Defaults to inputPerMillion / 10. */
  cachedInputPerMillion?: number;
  /** Display label for the UI. */
  label: string;
}

/**
 * Order matters — `findPricing` walks top-to-bottom and returns the
 * first match. Put EXACT matches above PREFIX matches that would
 * otherwise swallow them.
 */
export const AI_PRICING_REGISTRY: AiModelPricing[] = [
  // ── Anthropic (May 2026 rates) ──────────────────────────────────────
  {
    match: 'claude-haiku-4-5',
    matchKind: 'prefix',
    provider: 'anthropic',
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cachedInputPerMillion: 0.1,
    label: 'Claude Haiku 4.5',
  },
  {
    match: 'claude-sonnet-4-6',
    matchKind: 'prefix',
    provider: 'anthropic',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cachedInputPerMillion: 0.3,
    label: 'Claude Sonnet 4.6',
  },
  {
    match: 'claude-opus-4-7',
    matchKind: 'prefix',
    provider: 'anthropic',
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cachedInputPerMillion: 1.5,
    label: 'Claude Opus 4.7',
  },

  // ── OpenAI (approx May 2026 — varies by family) ─────────────────────
  {
    match: 'gpt-5-nano',
    matchKind: 'prefix',
    provider: 'openai',
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
    label: 'GPT-5 Nano',
  },
  {
    match: 'gpt-5-mini',
    matchKind: 'prefix',
    provider: 'openai',
    inputPerMillion: 0.25,
    outputPerMillion: 2.0,
    label: 'GPT-5 Mini',
  },
  {
    match: 'gpt-5',
    matchKind: 'prefix',
    provider: 'openai',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    label: 'GPT-5',
  },
  {
    match: 'gpt-4o',
    matchKind: 'prefix',
    provider: 'openai',
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    label: 'GPT-4o',
  },
  {
    match: 'o1',
    matchKind: 'prefix',
    provider: 'openai',
    inputPerMillion: 15.0,
    outputPerMillion: 60.0,
    label: 'OpenAI o1',
  },

  // ── Google direct ───────────────────────────────────────────────────
  {
    match: 'gemini-3-pro',
    matchKind: 'prefix',
    provider: 'google',
    inputPerMillion: 1.25,
    outputPerMillion: 5.0,
    label: 'Gemini 3 Pro',
  },
  {
    match: 'gemini-2-pro',
    matchKind: 'prefix',
    provider: 'google',
    inputPerMillion: 1.25,
    outputPerMillion: 5.0,
    label: 'Gemini 2 Pro',
  },
  {
    match: 'gemini-2-flash',
    matchKind: 'prefix',
    provider: 'google',
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
    label: 'Gemini 2 Flash',
  },

  // ── Kie market routes — directional pricing ─────────────────────────
  // Kie wraps these so actual cost on the user's invoice differs
  // slightly from the underlying model's rate card.
  {
    match: 'kie-gemini-3.1-pro',
    matchKind: 'exact',
    provider: 'kie',
    inputPerMillion: 1.25,
    outputPerMillion: 5.0,
    label: 'Kie · Gemini 3.1 Pro',
  },
  {
    match: 'kie-gemini-3-5-flash',
    matchKind: 'exact',
    provider: 'kie',
    inputPerMillion: 0.45,
    outputPerMillion: 2.7,
    label: 'Kie · Gemini 3.5 Flash',
  },
  {
    match: 'kie-gpt-5',
    matchKind: 'prefix',
    provider: 'kie',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    label: 'Kie · GPT-5 family',
  },
  {
    match: 'kie-claude',
    matchKind: 'prefix',
    provider: 'kie',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    label: 'Kie · Claude family',
  },
  {
    match: 'kie-codex',
    matchKind: 'prefix',
    provider: 'kie',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    label: 'Kie · Codex family',
  },
];

/** Locate pricing for a model id. Returns null when unknown — the
 *  caller should still log the row with cost=0 + record the unknown
 *  model so we can backfill the registry. */
export function findPricing(modelId: string): AiModelPricing | null {
  if (!modelId) return null;
  for (const entry of AI_PRICING_REGISTRY) {
    if (entry.matchKind === 'exact' && entry.match === modelId) return entry;
    if (entry.matchKind === 'prefix' && modelId.startsWith(entry.match)) return entry;
  }
  return null;
}

export interface ComputedCost {
  cost_usd_input: number;
  cost_usd_output: number;
  cost_usd_total: number;
  provider: AiProvider;
  applied_pricing: AiModelPricing | null;
}

/**
 * Compute cost in USD from input/output/cached token counts. Returns
 * zeros + provider='unknown' when the model isn't in the registry —
 * caller is responsible for logging the row anyway so spend audit is
 * complete.
 */
export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): ComputedCost {
  const pricing = findPricing(modelId);
  if (!pricing) {
    return {
      cost_usd_input: 0,
      cost_usd_output: 0,
      cost_usd_total: 0,
      provider: 'unknown',
      applied_pricing: null,
    };
  }
  const inRate = pricing.inputPerMillion / 1_000_000;
  const outRate = pricing.outputPerMillion / 1_000_000;
  const cachedRate =
    (pricing.cachedInputPerMillion ?? pricing.inputPerMillion / 10) / 1_000_000;

  const billableInput = Math.max(0, inputTokens - cachedInputTokens);
  const inputCost = billableInput * inRate + cachedInputTokens * cachedRate;
  const outputCost = outputTokens * outRate;
  return {
    cost_usd_input: round6(inputCost),
    cost_usd_output: round6(outputCost),
    cost_usd_total: round6(inputCost + outputCost),
    provider: pricing.provider,
    applied_pricing: pricing,
  };
}

function round6(n: number): number {
  // 6 decimals = sub-cent precision, plenty for token-level cost.
  return Math.round(n * 1_000_000) / 1_000_000;
}
