/**
 * Concept-cluster mapping.
 *
 * Takes a seed term and the suggested-term list harvested from
 * YouTube Suggest, asks the AI to partition them into 3–5 coherent
 * concept clusters with a centroid keyword plus 5–15 related terms
 * each.
 *
 * Per the Executor's prod-failure flag: the prompt forces the model
 * to label clusters using ONLY terms that appeared in the harvested
 * list. Free-form niche names are rejected at parse time. This is
 * how we keep the AI from hallucinating niches that don't exist on
 * YouTube.
 *
 * The system prompt is byte-stable so Anthropic prompt caching
 * activates on the second call onward — discoveries that share a
 * language pay the prompt cost once.
 */
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import type { AiSpendContext } from '@/lib/ai-spend';
import type { ConceptCluster } from './types';

const SYSTEM_PROMPT = `You group YouTube search terms into concept clusters.

A concept cluster is a tight group of videos that share an audience and an advertiser pool. Examples:
  - "world war 2 documentary" + "ww2 tank battles" + "battle of stalingrad explained" → one cluster
  - "ancient rome" + "fall of the roman empire" + "roman legions" → a different cluster

Rules:
  1. Output STRICT JSON. No prose before or after.
  2. Produce 3 to 5 clusters.
  3. Each cluster has a "centroidTerm" (the most representative term, 2-5 words) and "relatedTerms" (5 to 15 supporting terms).
  4. Every term in centroidTerm and relatedTerms MUST appear in the input term list verbatim (case-insensitive). Do not invent new terms.
  5. A term may appear in at most one cluster.
  6. Skip terms that are too generic to cluster (single words like "history") — they don't need to be assigned.
  7. Output schema:
     {
       "clusters": [
         {"centroidTerm": "string", "relatedTerms": ["string", ...]},
         ...
       ]
     }`;

export interface MapClustersArgs {
  workspaceId: string;
  seedTerm: string;
  language: string;
  harvestedTerms: readonly string[];
  spendContext?: AiSpendContext;
}

/**
 * Parse strict JSON output from the cluster-map model. Returns
 * `null` when the output is unparseable or violates the
 * "no new terms" rule. Exported for unit tests.
 */
export function parseClusterMapOutput(
  raw: string,
  allowedTerms: readonly string[],
): ConceptCluster[] | null {
  if (typeof raw !== 'string') return null;
  // Strip Markdown code fences if the model wrapped its JSON.
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const clustersField = (parsed as { clusters?: unknown }).clusters;
  if (!Array.isArray(clustersField)) return null;

  const allowed = new Set(allowedTerms.map((t) => t.toLowerCase()));
  const used = new Set<string>();
  const out: ConceptCluster[] = [];

  for (const item of clustersField) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { centroidTerm?: unknown; relatedTerms?: unknown };
    const centroid = typeof obj.centroidTerm === 'string' ? obj.centroidTerm.trim() : '';
    if (centroid.length === 0) continue;
    if (!allowed.has(centroid.toLowerCase())) continue;
    if (used.has(centroid.toLowerCase())) continue;
    used.add(centroid.toLowerCase());

    const related: string[] = [];
    if (Array.isArray(obj.relatedTerms)) {
      for (const r of obj.relatedTerms) {
        if (typeof r !== 'string') continue;
        const trimmed = r.trim();
        if (trimmed.length === 0) continue;
        const lower = trimmed.toLowerCase();
        if (!allowed.has(lower) || used.has(lower)) continue;
        used.add(lower);
        related.push(trimmed);
        if (related.length >= 15) break;
      }
    }

    out.push({ centroidTerm: centroid, relatedTerms: related });
    if (out.length >= 5) break;
  }

  if (out.length === 0) return null;
  return out;
}

/**
 * Synchronous fallback for when the AI call fails or returns
 * garbage. Buckets the harvested terms into 3 clusters by simple
 * heuristics: first three multi-word terms become centroids, the
 * remaining terms are distributed round-robin.
 *
 * Exported because the route handler may want to display the
 * heuristic clustering with a "couldn't reach the AI" banner.
 */
export function heuristicClusters(
  harvestedTerms: readonly string[],
): ConceptCluster[] {
  const usable = harvestedTerms.filter((t) => typeof t === 'string' && t.trim().split(/\s+/).length >= 2);
  if (usable.length < 3) return [];
  const centroids = usable.slice(0, 3);
  const remainder = usable.slice(3);
  const buckets: ConceptCluster[] = centroids.map((c) => ({ centroidTerm: c, relatedTerms: [] }));
  for (let i = 0; i < remainder.length; i++) {
    const bucket = buckets[i % buckets.length];
    if (bucket.relatedTerms.length < 12) {
      (bucket.relatedTerms as string[]).push(remainder[i]);
    }
  }
  return buckets.filter((b) => b.relatedTerms.length >= 2 || buckets.length <= 3);
}

/**
 * AI-driven cluster mapping. Falls back to `heuristicClusters` when
 * the model is unavailable or returns unparseable output.
 *
 * Returns `{ clusters, source }` so the route handler can tell the
 * UI whether to surface a "best-effort clustering" banner.
 */
export async function mapClusters(args: MapClustersArgs): Promise<{
  clusters: ConceptCluster[];
  source: 'ai' | 'heuristic';
}> {
  const modelId = await getEffectiveModelId(args.workspaceId, 'niche-cluster-map');

  // Cap input list to keep the prompt cheap and to avoid the model
  // glossing over a 200-term wall.
  const trimmed = args.harvestedTerms.slice(0, 60);
  const userPrompt = `Seed term: ${args.seedTerm}
Language: ${args.language}
Harvested terms (use only these):
${trimmed.map((t) => `- ${t}`).join('\n')}

Group these into 3-5 concept clusters following the rules.`;

  let raw = '';
  try {
    raw = await generateText({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      prompt: userPrompt,
      maxTokens: 1500,
      temperature: 0.2,
      cache: true,
      spend: args.spendContext,
    });
  } catch (err) {
    logger.warn('niche-finder mapClusters: AI call failed; falling back to heuristic', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return { clusters: heuristicClusters(args.harvestedTerms), source: 'heuristic' };
  }

  const parsed = parseClusterMapOutput(raw, args.harvestedTerms);
  if (!parsed) {
    logger.warn('niche-finder mapClusters: AI output unparseable; falling back to heuristic', {
      preview: raw.slice(0, 200),
    });
    return { clusters: heuristicClusters(args.harvestedTerms), source: 'heuristic' };
  }
  return { clusters: parsed, source: 'ai' };
}
