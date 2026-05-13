/**
 * AI brainstorm of children for a niche-taxonomy node.
 *
 * Two call shapes:
 *   - sub-niches under a category  ("Finance" → 15 monetization-tilted
 *     sub-niches like "credit card churning for beginners", "tax loss
 *     harvesting explained", ...)
 *   - micro-niches under a sub-niche ("real estate investing strategy"
 *     → 20 micro-niches like "long-term rental analysis",
 *     "house-hacking for beginners", ...)
 *
 * The system prompt is locale-aware: the AI is asked to produce names
 * a real YouTube viewer in (language, region) would actually search.
 *
 * Provider-agnostic. The model is resolved at call-time via
 * `getEffectiveModelId(workspaceId, 'niche-taxonomy-generate')` so the
 * workspace can swap to GPT-5 / Gemini / Perplexity from Settings or
 * from the inline picker in the niche-finder UI. The system prompt is
 * byte-stable so Anthropic prompt caching activates on repeat calls
 * for callers that resolve to a Claude model; non-Anthropic providers
 * see no cache mechanic, identical semantics.
 *
 * Output is strict JSON, validated by hand (the codebase doesn't use
 * Zod). Invalid outputs return an empty array — the caller decides
 * whether to fall back to curated-only or to retry.
 */
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import type { AiSpendContext } from '@/lib/ai-spend';
import { slugifyNiche, normalizeNicheName } from './slug';

const SYSTEM_PROMPT = `You generate monetization-tilted YouTube niche taxonomies for content creators.

The user gives you a parent niche, a target depth, a target language, and a region. You return a JSON array of more specific children that:

  1. Are concrete enough that a YouTube search for the name returns a coherent set of videos with an obvious audience.
  2. Lean toward monetization-friendly formats (tutorials, comparisons, deep dives, reviews) — not entertainment, kids content, or rights-fragile topics.
  3. Are written in the target language and feel natural to a real viewer in the target region. Do not translate concepts that wouldn't make sense in that market (e.g. "401k rollover" in regions without 401k).
  4. Do not duplicate names already in the existing-children list.
  5. Avoid names that are just rephrasings of the parent ("real estate investing" → "investing in real estate" is bad; "long-term rental property analysis" is good).
  6. For micro-niches (depth 2), be narrower than sub-niches: a sub-niche is "real estate investing strategy", a micro-niche is "house hacking with multifamily for beginners".

Output STRICT JSON only. No prose before or after. Schema:
  {
    "children": [
      { "name": "string (2-7 words)", "rationale": "string (one short clause, max 80 chars)" },
      ...
    ]
  }

Length: produce exactly the number of children requested.`;

export interface GenerateTaxonomyChildrenArgs {
  workspaceId: string;
  /** The parent node's display name (e.g. "Finance" or "real estate investing strategy"). */
  parentName: string;
  /** Whether children should be sub-niches or micro-niches. Drives prompt phrasing only. */
  childLevel: 'subniche' | 'microniche';
  /** Target ISO 639-1 language code (e.g. 'en'). */
  language: string;
  /** Target ISO 3166-1 alpha-2 region code (e.g. 'US'). */
  region: string;
  /** Names already in the parent's child set — the AI must not duplicate these. */
  existingChildNames: readonly string[];
  /** How many new children to produce. The model is asked for exactly this many. */
  count: number;
  /** Fire-and-forget spend logging context. */
  spendContext?: AiSpendContext;
}

/** One AI-suggested taxonomy child. The slug is derived locally — we
 *  don't trust the model to produce a unique kebab-case slug. */
export interface GeneratedTaxonomyChild {
  name: string;
  slug: string;
  rationale: string;
}

/** Generate children. Returns the AI-suggested list or an empty
 *  array on failure / unparseable output / no new ideas. The caller
 *  decides what to do with an empty result. */
export async function generateTaxonomyChildren(
  args: GenerateTaxonomyChildrenArgs,
): Promise<GeneratedTaxonomyChild[]> {
  if (args.count <= 0) return [];
  const modelId = await getEffectiveModelId(args.workspaceId, 'niche-taxonomy-generate');

  const existingBlock =
    args.existingChildNames.length > 0
      ? `\n\nDo NOT duplicate any of these existing names (case-insensitive match):\n${args.existingChildNames.map((n) => `  - ${n}`).join('\n')}`
      : '';

  const userPrompt = `Parent niche: ${args.parentName}
Target child level: ${args.childLevel} ${args.childLevel === 'microniche' ? '(narrower than a sub-niche, more specific)' : '(narrower than a category, but broad enough for 20+ videos)'}
Language: ${args.language}
Region: ${args.region}
Children needed: ${args.count}${existingBlock}

Return JSON only.`;

  let raw = '';
  try {
    raw = await generateText({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      prompt: userPrompt,
      // Headroom for ~25 children × ~80 chars each + JSON overhead.
      maxTokens: 2000,
      temperature: 0.6,
      cache: true,
      spend: args.spendContext,
    });
  } catch (err) {
    logger.warn('niche-finder taxonomy-generate: AI call failed', {
      detail: err instanceof Error ? err.message : String(err),
      modelId,
    });
    return [];
  }

  return parseTaxonomyOutput(raw, args.existingChildNames);
}

/** Parse a strict-JSON taxonomy generation. Exported for tests.
 *
 *  Robust to:
 *    - markdown code fences around the JSON
 *    - extra prose before/after the JSON object
 *    - duplicate names within the response
 *    - duplicates against the existing-children list (case-insensitive)
 *    - names that slugify to empty (e.g. "????")
 *    - names longer than 80 chars (truncated)
 *
 *  Returns at most 50 entries; the route layer further caps by count.
 *  Returns an empty array if the input can't be parsed at all. */
export function parseTaxonomyOutput(
  raw: string,
  existingChildNames: readonly string[],
): GeneratedTaxonomyChild[] {
  if (typeof raw !== 'string') return [];
  // Strip markdown fences and look for the first `{` so a chatty model
  // that prefaced with "Here are your niches:" still parses.
  const fenceStripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || lastBrace < firstBrace) return [];
  const candidate = fenceStripped.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const childrenField = (parsed as { children?: unknown }).children;
  if (!Array.isArray(childrenField)) return [];

  const seenNames = new Set(existingChildNames.map((n) => n.toLowerCase().trim()));
  const seenSlugs = new Set<string>();
  const out: GeneratedTaxonomyChild[] = [];

  for (const item of childrenField) {
    if (out.length >= 50) break;
    if (!item || typeof item !== 'object') continue;
    const obj = item as { name?: unknown; rationale?: unknown };
    const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (rawName.length === 0) continue;
    const name = normalizeNicheName(rawName).slice(0, 80);
    const slug = slugifyNiche(name);
    if (slug.length === 0) continue;
    if (seenNames.has(name.toLowerCase())) continue;
    if (seenSlugs.has(slug)) continue;
    seenNames.add(name.toLowerCase());
    seenSlugs.add(slug);
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 200) : '';
    out.push({ name, slug, rationale });
  }

  return out;
}
