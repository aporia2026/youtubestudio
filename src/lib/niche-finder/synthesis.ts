/**
 * AI-driven niche deep-dive memo synthesis.
 *
 * Takes the scored niche (rolled-up scores + per-cluster sample
 * data) and writes a short strategy memo plus 5-10 concrete video
 * ideas. The memo is Markdown; the route handler runs it through
 * the existing hardened `markdownToBasicHtml` helper before
 * rendering.
 *
 * The system prompt is byte-stable so Anthropic prompt caching
 * activates on the second call onward. User-side input (which
 * varies per niche) flows in via the user prompt.
 *
 * Per the lazy-user walkthrough (rule 10): the memo must end with
 * something actionable. We force the model to produce a labelled
 * "10-video bet" section so the UI can render those as one-click
 * "send to Project" rows in a future commit.
 */
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import type { AiSpendContext } from '@/lib/ai-spend';
import type { NicheScores } from './types';
import type { PersistedCluster } from './db';

const SYSTEM_PROMPT = `You write strategy memos for new YouTube channels.

You are given a niche, four already-computed scores (demand / crowdedness / monetization / fit), and the top channels + video patterns we observed in the niche. Your job is to produce a Markdown memo a creator can act on.

Rules:
  1. Plain language. No filler. No three-item lists for the sake of it. No em dashes. No "delve" / "leverage" / "seamless".
  2. Three sections, in this order, with these exact ## headings:
     - ## What this niche looks like
     - ## What a 10-video bet looks like
     - ## Risks and how to manage them
  3. In "What a 10-video bet looks like", produce 5 to 10 bullet items, each a concrete video idea: hook + angle. Use a Markdown bullet list.
  4. In "Risks", be honest about the downsides we saw in the data (one giant channel, low monetization, etc).
  5. 350 to 600 words total. No more.
  6. Never claim a specific dollar revenue figure. Talk about per-1,000-views ranges only, the same way the scores do.
  7. If a score is "rough guess" confidence, acknowledge that the read is preliminary in that section.

Output only the Markdown body. No preamble, no JSON envelope.`;

export interface SynthesizeMemoArgs {
  workspaceId: string;
  nicheName: string;
  scores: NicheScores;
  clusters: readonly PersistedCluster[];
  spendContext?: AiSpendContext;
}

export interface SynthesizeMemoResult {
  memo: string;
  modelId: string;
}

/** Compact a cluster down to the few facts the AI actually needs. */
function summariseCluster(c: PersistedCluster): string {
  const topVideos = c.topVideos.slice(0, 5).map((v) => `    - "${v.title}" — ${v.viewCount.toLocaleString()} views`).join('\n');
  const topChannels = c.topChannels.slice(0, 5).map((ch) => `    - ${ch.title} (${ch.subscriberCount.toLocaleString()} subs)`).join('\n');
  return `  Cluster: ${c.centroidTerm} (${c.sampleSize} sampled videos)
  Top channels:
${topChannels}
  Top videos:
${topVideos}`;
}

/**
 * Generate the memo. Returns an empty string on AI failure rather
 * than throwing — the route handler can still persist the report
 * with the scores intact and surface "memo generation failed, try
 * again" in the UI.
 */
export async function synthesizeDeepDiveMemo(
  args: SynthesizeMemoArgs,
): Promise<SynthesizeMemoResult> {
  const modelId = await getEffectiveModelId(args.workspaceId, 'niche-deep-dive');

  const scoresLine =
    `- How many people want this: ${args.scores.demand.label} (${args.scores.demand.confidence})\n` +
    `- How crowded it is: ${args.scores.supply.label} (${args.scores.supply.confidence})\n` +
    `- How much money it makes: $${args.scores.monetization.lowUsdPerMille.toFixed(0)}–$${args.scores.monetization.highUsdPerMille.toFixed(0)} per 1,000 views (${args.scores.monetization.confidence})\n` +
    `- How well it fits the operator: ${args.scores.fit.label} (${args.scores.fit.confidence})`;

  const clusterSummaries = args.clusters.map(summariseCluster).join('\n\n');

  const userPrompt = `Niche: ${args.nicheName}

Scores:
${scoresLine}

Clusters and what we observed:
${clusterSummaries}

Write the memo following the rules in the system prompt.`;

  let memo = '';
  try {
    memo = await generateText({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      prompt: userPrompt,
      maxTokens: 1800,
      temperature: 0.6,
      cache: true,
      spend: args.spendContext,
    });
  } catch (err) {
    logger.warn('niche-finder synthesizeDeepDiveMemo: AI call failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return { memo: '', modelId };
  }
  return { memo: memo.trim(), modelId };
}
