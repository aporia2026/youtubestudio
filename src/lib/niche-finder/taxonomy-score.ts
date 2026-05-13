/**
 * Lazy scorer for niche-taxonomy nodes.
 *
 * Reuses the existing per-cluster scoring machinery (demand / supply /
 * monetization / fit) from `scoring/` — taxonomy nodes are scored
 * exactly like the v0.5 sub-niches were, the difference is just where
 * the input names come from (curated + AI-generated DB rows vs the
 * static `categories.ts` list).
 *
 * Concurrency: nodes are scored in parallel with a small concurrency
 * cap so a single user click doesn't burst the YouTube API quota.
 * Cap is conservative; on the Vercel pro tier we have ~60 sec wallclock
 * per request, so even at concurrency=1 we'd handle ~10 nodes per
 * request. Concurrency=4 lets a typical 20-node batch finish in ~5 sec.
 */
import { harvestClusterSample } from './youtube-fetch';
import {
  scoreDemand,
  scoreSupply,
  scoreMonetization,
  scoreFit,
  rollupClusterScores,
  type ClusterScores,
} from './scoring';
import {
  upsertScore,
  type TaxonomyNodeRow,
} from './taxonomy-db';
import type {
  ClusterSample,
  NicheScores,
  OperatorFit,
  SampledChannel,
  SampledVideo,
} from './types';
import type { FetchedChannel, FetchedVideo } from './youtube-fetch';
import { logger } from '@/lib/logger';

/** How many top videos to pull per node for the sample. Matches the
 *  v0.5 default — bigger samples burn quota for marginal accuracy. */
const MAX_VIDEOS_PER_NODE = 30;

/** How many nodes to score concurrently. 4 is the sweet spot for the
 *  Vercel runtime: enough parallelism to finish a typical 20-node
 *  batch in ~5 sec, conservative enough that bursty quota usage
 *  doesn't trip the YouTube API's default 10k/day cap on a busy
 *  workspace. */
const SCORE_CONCURRENCY = 4;

const DEFAULT_FIT: OperatorFit = {
  interests: [],
  language: 'en',
  region: 'US',
  llmFitScore: 0.5,
  llmRationale: 'No fit input provided; defaulting to a neutral read.',
};

function buildSample(
  centroid: string,
  videos: readonly FetchedVideo[],
  channels: readonly FetchedChannel[],
): ClusterSample {
  const sampleVideos: SampledVideo[] = videos.map((v) => ({
    id: v.id,
    channelId: v.channelId,
    title: v.title,
    description: v.description,
    viewCount: v.viewCount,
    publishedAt: v.publishedAt,
    durationIso: v.durationIso,
    tags: v.tags,
  }));
  const sampleChannels: SampledChannel[] = channels.map((c) => ({
    id: c.id,
    subscriberCount: c.subscriberCount,
    videoCount: c.videoCount,
    createdAt: c.createdAt,
  }));
  return { centroidTerm: centroid, videos: sampleVideos, channels: sampleChannels };
}

export interface ScoreOneNodeArgs {
  workspaceId: string;
  node: TaxonomyNodeRow;
  /** Used to label the monetization prior with a category hint. The
   *  caller (route layer) is the one that knows the chain — we don't
   *  want this module re-querying the DB to find ancestors. */
  categoryHint: string;
  fit: OperatorFit;
}

export interface ScoreOneNodeResult {
  nodeId: string;
  scores: NicheScores | null;
  sampleSize: number;
  /** Filled when scoring failed for a recoverable reason (zero
   *  videos returned, fetch error). The caller surfaces this to the
   *  UI as a "couldn't score" placeholder. */
  error: string | null;
}

/** Score a single node. Pure orchestration: pulls a sample from
 *  YouTube, runs the four dimension scorers, persists the result.
 *  Persistence is synchronous (the caller awaits it) so a follow-up
 *  GET sees the new row. */
export async function scoreOneNode(args: ScoreOneNodeArgs): Promise<ScoreOneNodeResult> {
  const { node } = args;
  try {
    const { videos, channels } = await harvestClusterSample(node.name, {
      maxVideos: MAX_VIDEOS_PER_NODE,
      regionCode: node.region,
      relevanceLanguage: node.language,
    });
    if (videos.length === 0) {
      return {
        nodeId: node.id,
        scores: null,
        sampleSize: 0,
        error: 'No YouTube videos returned for this term — the niche may not exist on YouTube in this locale.',
      };
    }
    const sample = buildSample(node.name, videos, channels);
    const demand = scoreDemand(sample, 0);
    const supply = scoreSupply(sample);
    const monetization = scoreMonetization(sample, `${args.categoryHint} ${node.name}`);
    const fitScore = scoreFit(args.fit, sample.videos.length);
    const clusterScores: ClusterScores = {
      sampleSize: sample.videos.length,
      demand,
      supply,
      monetization,
      fit: fitScore,
    };
    const rolled: NicheScores = rollupClusterScores([clusterScores]);
    await upsertScore({
      nodeId: node.id,
      workspaceId: args.workspaceId,
      scores: rolled,
      sampleSize: sample.videos.length,
    });
    return { nodeId: node.id, scores: rolled, sampleSize: sample.videos.length, error: null };
  } catch (err) {
    logger.warn('niche-finder taxonomy-score: node scoring failed', {
      nodeId: node.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      nodeId: node.id,
      scores: null,
      sampleSize: 0,
      error: 'Scoring failed — try again in a moment.',
    };
  }
}

export interface ScoreBatchArgs {
  workspaceId: string;
  nodes: readonly TaxonomyNodeRow[];
  /** Per-node category hint (the root-category name). The caller
   *  computes this from the node chain so this module doesn't need
   *  to re-query the DB. Keys are node ids. */
  categoryHintByNodeId: Map<string, string>;
  fit?: OperatorFit;
}

/** Score a batch of nodes with bounded concurrency. Persists each
 *  result in place; returns an array of per-node results in the same
 *  order as the input. */
export async function scoreNodeBatch(args: ScoreBatchArgs): Promise<ScoreOneNodeResult[]> {
  const fit = args.fit ?? DEFAULT_FIT;
  const results: ScoreOneNodeResult[] = new Array(args.nodes.length);
  let cursor = 0;

  // Bounded worker pool — each "worker" pulls the next index off the
  // shared cursor until the array is exhausted. Cleaner than batching
  // into chunks because slow nodes don't block fast ones in the same
  // chunk.
  const workers = Array.from({ length: Math.min(SCORE_CONCURRENCY, args.nodes.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= args.nodes.length) return;
      const node = args.nodes[idx];
      const hint = args.categoryHintByNodeId.get(node.id) ?? '';
      results[idx] = await scoreOneNode({
        workspaceId: args.workspaceId,
        node,
        categoryHint: hint,
        fit,
      });
    }
  });
  await Promise.all(workers);
  return results;
}
