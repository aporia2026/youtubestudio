/**
 * Server-only Perplexity Sonar Deep Research client.
 *
 * Separate from `generateText` in `src/lib/ai.ts` because Sonar Deep
 * Research has its own quirks the generic abstraction doesn't capture:
 *   - 30-90s latency (multi-step research)
 *   - returns `citations[]` at the top level
 *   - reports `citation_tokens`, `num_search_queries`, `reasoning_tokens`
 *     in usage, which feed the deep-research-specific cost calc
 *   - JSON output mode is unreliable on long outputs (per the council
 *     Executor's warning), so we instruct JSON in the prompt and
 *     extract the first JSON block from the response instead of
 *     trusting strict provider-side JSON mode
 *
 * The generic Perplexity branch in ai.ts still works for the cheaper
 * sonar / sonar-pro tiers used elsewhere. This module is purpose-built
 * for the Niche Brief use case.
 *
 * Spend logging fires inline on success. Sonar Deep Research pricing
 * (verified 2026-05-13):
 *   - $2/M input tokens
 *   - $8/M output tokens
 *   - $2/M citation tokens
 *   - $3/M reasoning tokens
 *   - $5 per 1,000 search queries
 *   - $8 per 1,000 requests at medium context
 *
 * The token-based costs route through the standard `computeCost` /
 * `logAiSpend` path. The per-request + per-search fees are added on
 * top in `costUsd` (returned to the caller for storage in
 * `niche_favorite_briefs.cost_usd`) so the per-brief tooltip in the UI
 * shows the real spend.
 */
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { logAiSpend } from '@/lib/ai-spend';

/** Top-level brief citation enriched with domain quality. */
export interface BriefCitation {
  url: string;
  title: string | null;
  domain: string;
  /** Heuristic quality bucket per a hardcoded domain map. Used by the
   *  brief UI (badge color) and the export. */
  domain_quality: 'high' | 'medium' | 'low';
}

/** Per-call usage as returned by Perplexity for Sonar Deep Research.
 *  `prompt_tokens` / `completion_tokens` are always present;
 *  `citation_tokens`, `num_search_queries`, `reasoning_tokens` are
 *  Sonar-Deep-Research-specific. */
export interface PerplexityUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  citation_tokens?: number;
  num_search_queries?: number;
  reasoning_tokens?: number;
}

export interface DeepResearchResult {
  /** Raw assistant text. Caller is responsible for JSON extraction —
   *  use `extractFirstJsonBlock` from this module. */
  content: string;
  citations: BriefCitation[];
  usage: PerplexityUsage;
  /** Total cost in USD, including the per-request fee + per-search
   *  fees on top of the token-based cost. Persisted on the brief row
   *  so the UI can show "this brief cost $0.06". */
  costUsd: number;
  /** End-to-end latency for this call (ms). */
  durationMs: number;
}

interface DeepResearchOptions {
  /** Model id from AI_MODELS — `sonar-deep-research` by default.
   *  Accepting it as a parameter lets the caller honour the workspace
   *  picker (operator may downgrade to `sonar-pro` for cost). */
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  /** Defaults to 4000 — enough for an 8-section brief with citations. */
  maxTokens?: number;
  /** Spend-log context. Skipped (silently) when undefined. */
  spend?: {
    workspaceId: string;
    featureArea: string;
    metadata?: Record<string, unknown>;
  };
}

async function getPerplexityKey(): Promise<string> {
  if (process.env.PERPLEXITY_API_KEY) return process.env.PERPLEXITY_API_KEY;
  try {
    const store = await cookies();
    const key = store.get('perplexity_api_key')?.value;
    if (key) return key;
  } catch {
    /* not in a request context (cron) — env-only path */
  }
  throw new Error('Perplexity API key is not configured. Add it in Settings → API Keys or set PERPLEXITY_API_KEY.');
}

// ---------------------------------------------------------------------------
// Domain quality map — used to tag citations.
// ---------------------------------------------------------------------------

/** Domains we consider high-signal for niche/market research. */
const HIGH_QUALITY_DOMAINS = new Set([
  'youtube.com', 'www.youtube.com',
  'nytimes.com', 'wsj.com', 'bloomberg.com', 'ft.com', 'reuters.com',
  'theverge.com', 'wired.com', 'arstechnica.com',
  'techcrunch.com', 'forbes.com', 'fortune.com',
  'pewresearch.org', 'gartner.com', 'mckinsey.com',
  'sec.gov', 'fda.gov', 'cdc.gov',
  'wikipedia.org', 'en.wikipedia.org',
  'similarweb.com', 'semrush.com', 'ahrefs.com',
  'socialblade.com', 'noxinfluencer.com',
]);

/** Mid-tier domains — community signal but not authoritative. */
const MEDIUM_QUALITY_DOMAINS = new Set([
  'reddit.com', 'www.reddit.com', 'old.reddit.com',
  'news.ycombinator.com',
  'quora.com',
  'producthunt.com',
  'medium.com',
  'substack.com',
  'twitter.com', 'x.com',
]);

/** Patterns that signal SEO blog / listicle content. */
const LOW_QUALITY_PATTERNS = [
  /\btop[-\s]?\d+\b/i, // "top 10 …"
  /\b(best|hottest|trending|fastest[-\s]?growing)\s+(youtube|niche)/i,
  /\d{4}\s+(guide|niches|trends)/i, // "2026 guide", "2025 niches"
  /\b(make|earn)\s+money\s+(on|with|from)\b/i,
];

function domainQuality(url: string, title: string | null): 'high' | 'medium' | 'low' {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'low';
  }
  // Strip 'www.' for matching.
  const root = host.replace(/^www\./, '');
  if (HIGH_QUALITY_DOMAINS.has(host) || HIGH_QUALITY_DOMAINS.has(root)) return 'high';
  if (MEDIUM_QUALITY_DOMAINS.has(host) || MEDIUM_QUALITY_DOMAINS.has(root)) return 'medium';
  // Title pattern check — catches SEO blog content even on neutral hosts.
  if (title) {
    for (const pat of LOW_QUALITY_PATTERNS) {
      if (pat.test(title)) return 'low';
    }
  }
  // Default to medium for unrecognised domains — better than declaring
  // everything else low and burying real signal under a "low confidence"
  // shroud.
  return 'medium';
}

/** Parse a raw Perplexity citations field (which may be a string[] or
 *  an array of objects) into the enriched BriefCitation shape. */
export function normalizeCitations(raw: unknown): BriefCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefCitation[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      try {
        const host = new URL(item).hostname;
        out.push({ url: item, title: null, domain: host, domain_quality: domainQuality(item, null) });
      } catch {
        // Skip unparseable URLs rather than poisoning the list.
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const url = typeof o.url === 'string' ? o.url : null;
      if (!url) continue;
      const title = typeof o.title === 'string' ? o.title : null;
      try {
        const host = new URL(url).hostname;
        out.push({ url, title, domain: host, domain_quality: domainQuality(url, title) });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cost calculation — Sonar Deep Research is more complex than the generic
// token-pair pricing in `ai-pricing.ts`. We compute it here so the brief
// row can store an accurate per-call cost.
// ---------------------------------------------------------------------------

const SONAR_DEEP_RESEARCH = {
  /** $ per 1M input tokens */
  inputPerMTok: 2,
  /** $ per 1M output tokens */
  outputPerMTok: 8,
  /** $ per 1M citation tokens */
  citationPerMTok: 2,
  /** $ per 1M reasoning tokens */
  reasoningPerMTok: 3,
  /** $ per 1,000 search queries */
  perThousandSearches: 5,
  /** $ per 1,000 requests at medium context */
  perThousandRequestsMedium: 8,
} as const;

const SONAR_PRO = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  perThousandSearches: 5,
  perThousandRequestsMedium: 10,
} as const;

function computeDeepResearchCost(modelId: string, usage: PerplexityUsage): number {
  if (modelId === 'sonar-deep-research') {
    const tokens =
      (usage.prompt_tokens * SONAR_DEEP_RESEARCH.inputPerMTok +
        usage.completion_tokens * SONAR_DEEP_RESEARCH.outputPerMTok +
        (usage.citation_tokens ?? 0) * SONAR_DEEP_RESEARCH.citationPerMTok +
        (usage.reasoning_tokens ?? 0) * SONAR_DEEP_RESEARCH.reasoningPerMTok) /
      1_000_000;
    const searches = ((usage.num_search_queries ?? 0) / 1000) * SONAR_DEEP_RESEARCH.perThousandSearches;
    const request = SONAR_DEEP_RESEARCH.perThousandRequestsMedium / 1000;
    return Number((tokens + searches + request).toFixed(4));
  }
  if (modelId === 'sonar-pro') {
    const tokens =
      (usage.prompt_tokens * SONAR_PRO.inputPerMTok + usage.completion_tokens * SONAR_PRO.outputPerMTok) /
      1_000_000;
    const searches = ((usage.num_search_queries ?? 0) / 1000) * SONAR_PRO.perThousandSearches;
    const request = SONAR_PRO.perThousandRequestsMedium / 1000;
    return Number((tokens + searches + request).toFixed(4));
  }
  // Other Perplexity tiers — fall through to a simple token-based estimate.
  // ai-pricing.ts handles these; we keep a coarse local estimate to avoid
  // a circular import path.
  const fallbackTokens =
    (usage.prompt_tokens * SONAR_PRO.inputPerMTok + usage.completion_tokens * SONAR_PRO.outputPerMTok) /
    1_000_000;
  return Number(fallbackTokens.toFixed(4));
}

// ---------------------------------------------------------------------------
// The main call.
// ---------------------------------------------------------------------------

/** Call Perplexity (Sonar Deep Research by default) for a structured
 *  niche brief. Returns the raw content + citations + usage + cost.
 *  Throws on API error — caller wraps in try/catch + writes a failed
 *  brief row. */
export async function callPerplexityDeepResearch(
  opts: DeepResearchOptions,
): Promise<DeepResearchResult> {
  const key = await getPerplexityKey();
  const startedAt = Date.now();

  const body = {
    model: opts.modelId,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ],
    // Per the ai.ts precedent: reasoning + deep-research tiers want low temp.
    temperature: 0.1,
    max_tokens: opts.maxTokens ?? 4000,
    // Sonar accepts a `search_context_size` hint — medium balances cost vs
    // recall for the use case. The per-request fee maps to this tier
    // (locked into computeDeepResearchCost above).
    web_search_options: { search_context_size: 'medium' },
    // Per Executor council warning: don't use strict provider-side JSON mode
    // on long deep-research outputs — it truncates / 500s. Instead instruct
    // JSON in the prompt and parse with extractFirstJsonBlock below.
    return_citations: true,
    return_images: false,
  };

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Perplexity ${opts.modelId} error ${res.status}: ${errText.slice(0, 500)}`);
  }

  type PerplexityResponse = {
    choices?: { message?: { content?: string } }[];
    citations?: unknown;
    usage?: PerplexityUsage;
  };
  const data = (await res.json()) as PerplexityResponse;
  const content = data.choices?.[0]?.message?.content ?? '';
  const citations = normalizeCitations(data.citations);
  const usage: PerplexityUsage = data.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const costUsd = computeDeepResearchCost(opts.modelId, usage);
  const durationMs = Date.now() - startedAt;

  // Spend logging — fire-and-forget, swallow errors. We pass token-only
  // numbers to logAiSpend because `ai_spend_log.cost_usd_total` is computed
  // from `computeCost` which doesn't know about Perplexity's per-request /
  // per-search fees. The per-brief cost (the one shown in UI) is the
  // returned `costUsd` value — that's the authoritative figure.
  if (opts.spend) {
    void logAiSpend({
      context: {
        workspaceId: opts.spend.workspaceId,
        featureArea: opts.spend.featureArea,
        metadata: { ...(opts.spend.metadata ?? {}), perplexity_cost_usd: costUsd, durationMs },
      },
      modelId: opts.modelId,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      durationMs,
    }).catch((err) => {
      logger.warn('callPerplexityDeepResearch: spend log failed', {
        detail: err instanceof Error ? err.message : String(err),
        model_id: opts.modelId,
      });
    });
  }

  return { content, citations, usage, costUsd, durationMs };
}

// ---------------------------------------------------------------------------
// JSON extraction — robust to Sonar Deep Research's preamble/postamble.
// ---------------------------------------------------------------------------

/** Pull the first balanced JSON object out of a free-form model
 *  response. Returns null when nothing parseable is found.
 *
 *  The model often wraps its JSON in prose ("Here is the brief: { ... }
 *  Note: I focused on …"). Stripping a code fence is the common case;
 *  the fallback walks brace-by-brace to find a balanced object.
 *
 *  Pure function — exported for tests. */
export function extractFirstJsonBlock<T = unknown>(text: string): T | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Code-fence path: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const parsed = tryParse<T>(fenceMatch[1]);
    if (parsed !== null) return parsed;
  }

  // Brace-walking fallback — find the first { and walk until the matching
  // close brace, respecting string escapes. Handles nested objects.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return tryParse<T>(text.slice(start, i + 1));
      }
    }
  }
  return null;
}

function tryParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test-only export to make the cost math testable without spinning up
// the real API client.
// ---------------------------------------------------------------------------
export const _internals = {
  computeDeepResearchCost,
  domainQuality,
};
