/**
 * Category-browser discovery (mode C).
 *
 * Operator picks a category from the hand-curated taxonomy in
 * `categories.ts`. We score each of the category's 4-6 sub-niches
 * with real YouTube data and return them ranked.
 *
 * Quota cost: 4-6 sub-niches × ~102 units = 400-600 units per
 * category. Cached for 7 days per workspace + category slug.
 *
 * Cross-workspace cache could be tempting (the taxonomy is global,
 * the YouTube data is public) but we keep it workspace-scoped to
 * stay safely on the right side of the YouTube ToS until the
 * Phase 13.3 productization audit.
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
import { slugifyNiche, normalizeNicheName } from './slug';
import { getCategory, type NicheCategory } from './categories';
import {
  getDiscovery,
  hashDiscoveryInput,
  upsertDiscovery,
  type DiscoveryResultItem,
  type NicheDiscoveryRow,
} from './discoveries-db';
import type { ClusterSample, NicheScores, OperatorFit, SampledChannel, SampledVideo } from './types';
import type { FetchedChannel, FetchedVideo } from './youtube-fetch';

export interface DiscoverFromCategoryArgs {
  workspaceId: string;
  categorySlug: string;
  language?: string;
  region?: string;
  fit?: OperatorFit;
  force?: boolean;
}

export interface DiscoverFromCategoryResult {
  discovery: NicheDiscoveryRow;
  cached: boolean;
  category: NicheCategory | null;
}

const DEFAULT_FIT: OperatorFit = {
  interests: [],
  language: 'en',
  region: 'US',
  llmFitScore: 0.5,
  llmRationale: 'No fit input provided; defaulting to a neutral read.',
};

const MAX_VIDEOS_PER_CLUSTER = 30;

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

export async function discoverFromCategory(
  args: DiscoverFromCategoryArgs,
): Promise<DiscoverFromCategoryResult> {
  const category = getCategory(args.categorySlug);
  if (!category) {
    return {
      discovery: {
        id: '',
        workspace_id: args.workspaceId,
        kind: 'category',
        input_hash: hashDiscoveryInput(args.categorySlug),
        input_summary: `Category: ${args.categorySlug}`,
        results: [],
        created_at: new Date().toISOString(),
      },
      cached: false,
      category: null,
    };
  }

  const fit = args.fit ?? DEFAULT_FIT;
  const language = args.language ?? fit.language ?? 'en';
  const region = args.region ?? fit.region ?? 'US';
  const inputHash = hashDiscoveryInput(`${category.slug}|${language}|${region}`);
  const summary = `Category: ${category.name}`;

  // Cache check.
  if (!args.force) {
    const cached = await getDiscovery({
      workspaceId: args.workspaceId,
      kind: 'category',
      inputHash,
    });
    if (cached) return { discovery: cached, cached: true, category };
  }

  // Score each sub-niche.
  const results: DiscoveryResultItem[] = [];
  for (const subNiche of category.subNiches) {
    const { videos, channels } = await harvestClusterSample(subNiche, {
      maxVideos: MAX_VIDEOS_PER_CLUSTER,
      regionCode: region,
      relevanceLanguage: language,
    });
    if (videos.length === 0) continue;
    const sample = buildSample(subNiche, videos, channels);
    const demand = scoreDemand(sample, 0);
    const supply = scoreSupply(sample);
    const monetization = scoreMonetization(sample, `${category.name} ${subNiche}`);
    const fitScore = scoreFit(fit, sample.videos.length);
    const clusterScores: ClusterScores = {
      sampleSize: sample.videos.length,
      demand,
      supply,
      monetization,
      fit: fitScore,
    };
    const rolled: NicheScores = rollupClusterScores([clusterScores]);
    results.push({
      slug: slugifyNiche(subNiche),
      name: normalizeNicheName(subNiche),
      rationale: `Sub-niche of ${category.name}. ${sample.videos.length} top videos sampled.`,
      scores: rolled,
    });
  }

  results.sort((a, b) => b.scores.combined - a.scores.combined);

  const row = await upsertDiscovery({
    workspaceId: args.workspaceId,
    kind: 'category',
    inputHash,
    inputSummary: summary,
    results,
  });

  return { discovery: row, cached: false, category };
}
