/**
 * Niche-finder deep-dive orchestrator.
 *
 * Single entry point for the v0.5 flow:
 *
 *   1. Slugify the input + check the workspace's cached report.
 *   2. Expand the seed via YouTube Suggest.
 *   3. AI-map the harvested terms into 3-5 concept clusters.
 *   4. For each cluster, run `search.list` + batch-fetch videos +
 *      batch-fetch channels (cached via niche_finder_api_cache).
 *   5. Score each cluster (pure helpers).
 *   6. Roll up to niche scores.
 *   7. AI-synthesize the strategy memo.
 *   8. Persist to `niche_reports` (UPSERT).
 *
 * All AI calls thread a `spend` context so the existing
 * `/spend` dashboard attributes the cost.
 *
 * Quota budget per deep-dive:
 *   - 3-5 cluster searches × 100 units  = 300-500 units
 *   - 3-5 videos.list batches × 1 unit  = 3-5 units
 *   - 1-2 channels.list batches × 1 unit = 1-2 units
 *   ≈ 506 units worst case, fits inside the 10K-unit default daily
 *     quota with room for ~20 deep-dives per day. Cache hits cost 0.
 */
import {
  scoreDemand,
  scoreSupply,
  scoreMonetization,
  scoreFit,
  rollupClusterScores,
  type ClusterScores,
} from './scoring';
import { expandSeedTerm } from './youtube-suggest';
import { harvestClusterSample, type FetchedChannel, type FetchedVideo } from './youtube-fetch';
import { mapClusters } from './clusters';
import { synthesizeDeepDiveMemo } from './synthesis';
import { upsertNicheReport, getNicheReport, type NicheReportRow, type PersistedCluster } from './db';
import { normalizeNicheName, slugifyNiche } from './slug';
import type { AiSpendContext } from '@/lib/ai-spend';
import type { ClusterSample, ConceptCluster, OperatorFit, NicheScores } from './types';
import { logger } from '@/lib/logger';

export interface RunDeepDiveArgs {
  workspaceId: string;
  /** Free-text niche name from the operator. */
  nicheText: string;
  /** Optional operator-fit input. Defaults to a neutral fit if
   *  omitted — the operator can still get a useful report without
   *  filling in interests. */
  fit?: OperatorFit;
  /** Per-call options. */
  language?: string;
  region?: string;
  /** Force a re-run even if a cached report exists. */
  force?: boolean;
}

export interface RunDeepDiveResult {
  report: NicheReportRow;
  cached: boolean;
  /** Whether clustering came from the AI or the heuristic fallback.
   *  The UI surfaces a banner when the value is 'heuristic'. */
  clusterSource: 'ai' | 'heuristic';
}

const DEFAULT_FIT: OperatorFit = {
  interests: [],
  language: 'en',
  region: 'US',
  llmFitScore: 0.5,
  llmRationale: 'No fit input provided; defaulting to a neutral could-work read.',
};

/** Cap on how many clusters we score per niche. Keeps quota bounded
 *  and matches the "3-8 clusters per niche" rule of thumb in the
 *  plan. We choose 5 as a happy medium. */
const MAX_CLUSTERS = 5;

/** Minimum number of harvested suggest terms before we even try the
 *  AI clustering. Below this we fall back to a single-cluster
 *  treatment using the seed as its own centroid. */
const MIN_TERMS_FOR_CLUSTERING = 6;

/** Convert a fetched-video + fetched-channel pair into a
 *  `ClusterSample` the pure scorer consumes. */
function toClusterSample(
  centroidTerm: string,
  videos: readonly FetchedVideo[],
  channels: readonly FetchedChannel[],
): ClusterSample {
  return {
    centroidTerm,
    videos: videos.map((v) => ({
      id: v.id,
      channelId: v.channelId,
      title: v.title,
      description: v.description,
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,
      durationIso: v.durationIso,
      tags: v.tags,
    })),
    channels: channels.map((c) => ({
      id: c.id,
      subscriberCount: c.subscriberCount,
      videoCount: c.videoCount,
      createdAt: c.createdAt,
    })),
  };
}

/** Build a `PersistedCluster` for persistence + UI display. */
function toPersistedCluster(
  cluster: ConceptCluster,
  videos: readonly FetchedVideo[],
  channels: readonly FetchedChannel[],
  scores: NicheScores,
): PersistedCluster {
  const channelById = new Map<string, FetchedChannel>();
  for (const c of channels) channelById.set(c.id, c);
  return {
    centroidTerm: cluster.centroidTerm,
    relatedTerms: cluster.relatedTerms.slice(),
    sampleSize: videos.length,
    topChannels: channels
      .slice()
      .sort((a, b) => b.subscriberCount - a.subscriberCount)
      .slice(0, 10)
      .map((c) => ({
        id: c.id,
        title: c.title,
        subscriberCount: c.subscriberCount,
        thumbnailUrl: c.thumbnailUrl,
      })),
    topVideos: videos.slice(0, 20).map((v) => ({
      id: v.id,
      title: v.title,
      viewCount: v.viewCount,
      durationIso: v.durationIso,
      publishedAt: v.publishedAt,
      channelId: v.channelId,
      thumbnailUrl: v.thumbnailUrl,
    })),
    scores,
  };
}

/** Public orchestrator. Returns a persisted report. */
export async function runDeepDive(args: RunDeepDiveArgs): Promise<RunDeepDiveResult> {
  const slug = slugifyNiche(args.nicheText);
  const name = normalizeNicheName(args.nicheText);

  // Cache hit?
  if (!args.force) {
    const cached = await getNicheReport(args.workspaceId, slug);
    if (cached) {
      return { report: cached, cached: true, clusterSource: 'ai' };
    }
  }

  const spendContext: AiSpendContext = {
    workspaceId: args.workspaceId,
    featureArea: 'niche_finder.deep_dive',
    metadata: { slug },
  };
  const fit = args.fit ?? DEFAULT_FIT;
  const language = args.language ?? fit.language ?? 'en';
  const region = args.region ?? fit.region ?? 'US';

  // Step 1: harvest terms.
  const harvestedTerms = await expandSeedTerm(name, language, 50);
  logger.info('niche-finder deep-dive: terms harvested', {
    slug,
    count: harvestedTerms.length,
  });

  // Step 2: cluster.
  let clusters: ConceptCluster[];
  let clusterSource: 'ai' | 'heuristic' = 'ai';
  if (harvestedTerms.length >= MIN_TERMS_FOR_CLUSTERING) {
    const out = await mapClusters({
      workspaceId: args.workspaceId,
      seedTerm: name,
      language,
      harvestedTerms,
      spendContext: { ...spendContext, featureArea: 'niche_finder.cluster_map' },
    });
    clusters = out.clusters;
    clusterSource = out.source;
  } else {
    // Single-cluster degraded mode — Suggest may have been down.
    clusters = [{ centroidTerm: name, relatedTerms: harvestedTerms.slice(1) }];
    clusterSource = 'heuristic';
  }
  clusters = clusters.slice(0, MAX_CLUSTERS);

  // Step 3+4: fetch a sample for each cluster and score it. We
  // serialise these to be polite to the YouTube quota and to make
  // the 429-handling story simpler.
  const persistedClusters: PersistedCluster[] = [];
  const clusterScoresList: ClusterScores[] = [];

  for (const cluster of clusters) {
    const { videos, channels } = await harvestClusterSample(cluster.centroidTerm, {
      maxVideos: 30,
      regionCode: region,
      relevanceLanguage: language,
    });

    const sample = toClusterSample(cluster.centroidTerm, videos, channels);
    const demand = scoreDemand(sample, cluster.relatedTerms.length);
    const supply = scoreSupply(sample);
    const monetization = scoreMonetization(sample, `${name} ${cluster.centroidTerm}`);
    const fitScore = scoreFit(fit, sample.videos.length);
    const clusterScores: ClusterScores = {
      sampleSize: sample.videos.length,
      demand,
      supply,
      monetization,
      fit: fitScore,
    };
    clusterScoresList.push(clusterScores);

    // Tuck the per-cluster scores into the persisted record under
    // the same NicheScores shape so the UI uses one renderer for
    // both niche-level and cluster-level views.
    const perClusterScores: NicheScores = {
      demand,
      supply,
      monetization,
      fit: fitScore,
      combined:
        0.3 * demand.numeric +
        0.3 * (1 - supply.numeric) +
        0.3 * monetization.numeric +
        0.1 * fitScore.numeric,
    };
    persistedClusters.push(toPersistedCluster(cluster, videos, channels, perClusterScores));
  }

  // Step 5: roll up. If we have no clusters with any samples (every
  // YouTube fetch returned 0 videos), we still emit a report with
  // empty data + a heuristic memo so the user sees something.
  let nicheScores: NicheScores;
  if (clusterScoresList.length > 0 && clusterScoresList.some((c) => c.sampleSize > 0)) {
    nicheScores = rollupClusterScores(clusterScoresList);
  } else {
    nicheScores = {
      demand: { numeric: 0, label: 'low', confidence: 'rough guess', evidence: { reason: 'no sample data' } },
      supply: { numeric: 0, label: 'wide open', confidence: 'rough guess', evidence: { reason: 'no sample data' } },
      monetization: {
        numeric: 0,
        label: 'low',
        confidence: 'rough guess',
        lowUsdPerMille: 0,
        highUsdPerMille: 0,
        evidence: { reason: 'no sample data' },
      },
      fit: scoreFit(fit, 0),
      combined: 0,
    };
  }

  // Step 6: synthesize memo.
  const memoOut = await synthesizeDeepDiveMemo({
    workspaceId: args.workspaceId,
    nicheName: name,
    scores: nicheScores,
    clusters: persistedClusters,
    spendContext: { ...spendContext, featureArea: 'niche_finder.deep_dive_memo' },
  });

  // Step 7: persist.
  const row = await upsertNicheReport({
    workspaceId: args.workspaceId,
    slug,
    name,
    scores: nicheScores,
    clusters: persistedClusters,
    aiMemo: memoOut.memo,
    aiModel: memoOut.modelId,
    spendUsdCents: null,
  });

  return { report: row, cached: false, clusterSource };
}
