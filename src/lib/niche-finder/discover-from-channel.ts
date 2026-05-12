/**
 * Channel-paste discovery (mode B).
 *
 * "Paste a YouTube channel URL you admire" — we fetch its 50
 * most-viewed recent uploads, AI-cluster the titles into concept
 * clusters, score each cluster using the v0.5 scoring engine, and
 * return a ranked list of niches the channel is winning.
 *
 * This is the First Principles Thinker's v0.5 reframe from the
 * council pass, originally deferred. Reuses the entire v0.5
 * pipeline (Suggest expansion swapped for "the channel's own
 * video titles" as the harvested term list).
 *
 * Quota budget:
 *   - 1 channels.list batch (1 unit) for channel metadata
 *   - 1 channels.list batch (1 unit) for uploads-playlist lookup
 *   - 1 playlistItems.list (1 unit) for the upload IDs
 *   - 1 videos.list batch of 50 (1 unit) for video details
 *   ≈ 4 quota units, far cheaper than the 506 v0.5 deep-dive.
 *
 * We do NOT run search.list per cluster — we have the channel's
 * own videos. Headroom analysis (how saturated the broader market
 * is for these clusters) is intentionally deferred to a follow-up
 * because it costs 100 units per cluster and would put this mode
 * on par with v0.5 cost-wise.
 */
import { fetchChannelData, fetchChannelVideos } from '@/lib/youtube';
import { mapClusters } from './clusters';
import {
  scoreDemand,
  scoreSupply,
  scoreMonetization,
  scoreFit,
  rollupClusterScores,
  type ClusterScores,
} from './scoring';
import { slugifyNiche, normalizeNicheName } from './slug';
import {
  canonicaliseInterests,
  getDiscovery,
  hashDiscoveryInput,
  upsertDiscovery,
  type DiscoveryResultItem,
  type NicheDiscoveryRow,
} from './discoveries-db';
import type { AiSpendContext } from '@/lib/ai-spend';
import type { ClusterSample, OperatorFit, NicheScores, SampledChannel, SampledVideo } from './types';
import { logger } from '@/lib/logger';

export interface DiscoverFromChannelArgs {
  workspaceId: string;
  channelUrl: string;
  language?: string;
  region?: string;
  fit?: OperatorFit;
  force?: boolean;
}

export interface DiscoverFromChannelResult {
  discovery: NicheDiscoveryRow;
  cached: boolean;
  /** When the YouTube fetch failed entirely. The UI surfaces a
   *  "couldn't reach YouTube" message rather than an empty grid. */
  fetchOk: boolean;
}

const DEFAULT_FIT: OperatorFit = {
  interests: [],
  language: 'en',
  region: 'US',
  llmFitScore: 0.5,
  llmRationale: 'No fit input provided; defaulting to a neutral read.',
};

const MAX_CLUSTERS = 5;

/** Run the discovery. Returns either a populated discovery row or
 *  a thin row with `fetchOk: false` so the UI can degrade cleanly. */
export async function discoverFromChannel(
  args: DiscoverFromChannelArgs,
): Promise<DiscoverFromChannelResult> {
  // Step 1: resolve the channel URL → channel data. fetchChannelData
  // already handles @handle and channel-id URL forms.
  const channelData = await fetchChannelData(args.channelUrl);
  if (!channelData) {
    return {
      discovery: {
        id: '',
        workspace_id: args.workspaceId,
        kind: 'channel',
        input_hash: hashDiscoveryInput(args.channelUrl.trim().toLowerCase()),
        input_summary: `Channel: ${args.channelUrl.slice(0, 100)}`,
        results: [],
        created_at: new Date().toISOString(),
      },
      cached: false,
      fetchOk: false,
    };
  }

  const inputHash = hashDiscoveryInput(channelData.id);
  const summary = `Channel: ${channelData.title}`;

  // Step 2: cache check.
  if (!args.force) {
    const cached = await getDiscovery({
      workspaceId: args.workspaceId,
      kind: 'channel',
      inputHash,
    });
    if (cached) return { discovery: cached, cached: true, fetchOk: true };
  }

  // Step 3: fetch the channel's recent uploads.
  const rawVideos = await fetchChannelVideos(channelData.id, 50);
  if (rawVideos.length === 0) {
    logger.warn('niche-finder discoverFromChannel: no uploads returned', { channelId: channelData.id });
    return {
      discovery: {
        id: '',
        workspace_id: args.workspaceId,
        kind: 'channel',
        input_hash: inputHash,
        input_summary: summary,
        results: [],
        created_at: new Date().toISOString(),
      },
      cached: false,
      fetchOk: false,
    };
  }

  // Step 4: harvest "terms" — the video titles are our cluster
  // input. We cap at 50 to keep the AI prompt cheap. Each title
  // becomes a candidate cluster centroid.
  const harvestedTerms = rawVideos
    .map((v) => v.title)
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .slice(0, 50);

  // Step 5: AI-cluster (constrained to the actual titles so the
  // model can't hallucinate niches that don't exist on this
  // channel).
  const spendContext: AiSpendContext = {
    workspaceId: args.workspaceId,
    featureArea: 'niche_finder.discover_from_channel',
    metadata: { channelId: channelData.id },
  };
  const { clusters } = await mapClusters({
    workspaceId: args.workspaceId,
    seedTerm: channelData.title,
    language: args.language ?? 'en',
    harvestedTerms,
    spendContext,
  });

  const cappedClusters = clusters.slice(0, MAX_CLUSTERS);
  if (cappedClusters.length === 0) {
    return {
      discovery: {
        id: '',
        workspace_id: args.workspaceId,
        kind: 'channel',
        input_hash: inputHash,
        input_summary: summary,
        results: [],
        created_at: new Date().toISOString(),
      },
      cached: false,
      fetchOk: true,
    };
  }

  // Step 6: for each cluster, match the channel's videos whose
  // title contains the centroid or a related term, then score that
  // subset. This gives us "what is the channel doing in this
  // cluster" without an extra YouTube search.
  const fit = args.fit ?? DEFAULT_FIT;
  const results: DiscoveryResultItem[] = [];

  for (const cluster of cappedClusters) {
    const matchTokens = [cluster.centroidTerm, ...cluster.relatedTerms].map((t) =>
      t.toLowerCase(),
    );
    const matched = rawVideos.filter((v) => {
      const title = (v.title ?? '').toLowerCase();
      return matchTokens.some((tok) => tok.length > 2 && title.includes(tok));
    });
    if (matched.length === 0) continue;

    const sampleVideos: SampledVideo[] = matched.map((v) => ({
      id: v.id,
      channelId: channelData.id,
      title: v.title,
      description: v.description,
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,
      durationIso: v.duration,
      tags: v.tags ?? [],
    }));
    const sampleChannel: SampledChannel = {
      id: channelData.id,
      subscriberCount: channelData.subscriberCount,
      videoCount: channelData.videoCount,
      createdAt: null,
    };
    const sample: ClusterSample = {
      centroidTerm: cluster.centroidTerm,
      videos: sampleVideos,
      channels: [sampleChannel],
    };

    const demand = scoreDemand(sample, cluster.relatedTerms.length);
    const supply = scoreSupply(sample);
    const monetization = scoreMonetization(sample, `${channelData.title} ${cluster.centroidTerm}`);
    const fitScore = scoreFit(fit, sampleVideos.length);

    const clusterScores: ClusterScores = {
      sampleSize: sampleVideos.length,
      demand,
      supply,
      monetization,
      fit: fitScore,
    };
    const rolled: NicheScores = rollupClusterScores([clusterScores]);

    const slug = slugifyNiche(cluster.centroidTerm);
    const name = normalizeNicheName(cluster.centroidTerm);
    const rationale =
      `${matched.length} of this channel's recent videos sit in this cluster. ` +
      `Demand: ${demand.label}; per-1k revenue band $${monetization.lowUsdPerMille.toFixed(0)}–$${monetization.highUsdPerMille.toFixed(0)}.`;

    results.push({
      slug,
      name,
      rationale: rationale.slice(0, 200),
      scores: rolled,
    });
  }

  // Step 7: sort by combined score, descending.
  results.sort((a, b) => b.scores.combined - a.scores.combined);

  // Step 8: persist.
  const row = await upsertDiscovery({
    workspaceId: args.workspaceId,
    kind: 'channel',
    inputHash,
    inputSummary: summary,
    results,
  });

  return { discovery: row, cached: false, fetchOk: true };
}

/** Exported for tests — confirms two interest-list shapes hash to
 *  the same key regardless of ordering / casing. */
export function debugInterestHash(interests: readonly string[]): string {
  return hashDiscoveryInput(canonicaliseInterests(interests));
}
