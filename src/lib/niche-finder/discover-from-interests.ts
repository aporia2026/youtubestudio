/**
 * Interest-based discovery (mode A).
 *
 * Two-pass orchestration:
 *   1. AI proposes 8 candidate niches from the operator's interests
 *      + language + region. Strict-JSON output, prompt-cached.
 *   2. For each candidate niche, run a single search.list pull (30
 *      videos) + batch-fetch videos + channels, score the cluster.
 *
 * Quota cost: 8 niches × ~102 units = ~820 quota units per
 * discovery (10K-unit default → ~12 discoveries/day). Cache hits
 * cost 0 quota and 0 AI.
 *
 * Diversity is enforced in the prompt — the model is asked to span
 * different categories rather than producing 8 variations of
 * "history channels." If the user re-runs with the same interest
 * list within the cache TTL, they get the exact same eight (which
 * is what they want for a discovery — stable rankings make for a
 * trustable tool).
 */
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
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
import {
  canonicaliseInterests,
  getDiscovery,
  hashDiscoveryInput,
  upsertDiscovery,
  type DiscoveryResultItem,
  type NicheDiscoveryRow,
} from './discoveries-db';
import type { AiSpendContext } from '@/lib/ai-spend';
import type { ClusterSample, NicheScores, OperatorFit, SampledChannel, SampledVideo } from './types';
import type { FetchedChannel, FetchedVideo } from './youtube-fetch';
import { logger } from '@/lib/logger';

const SYSTEM_PROMPT = `You suggest YouTube niches a creator could start a channel in.

Inputs you'll see: three interests, language, region.
Output STRICT JSON. No prose before or after.

Schema:
  {
    "niches": [
      {"name": "string", "rationale": "string"},
      ...
    ]
  }

Rules:
  1. Exactly 8 niches.
  2. Each "name" is a 2-6 word phrase specific enough that searching it on YouTube returns a coherent set of videos. NOT generic ("history") — specific ("ww2 tank battles", "ancient rome animated history").
  3. Tilt toward niches with reasonable ad monetization. Avoid kids content (COPPA suppresses RPM), music covers (copyright drag), reaction videos (low CPM).
  4. Span DIVERSE categories — do not return 8 variations of one topic. If the operator's interests narrow to a single category, broaden the niches by audience subsets, format ("animated", "documentary", "explained"), or geography.
  5. Each "rationale" is one short sentence about why this fits the operator and could be a good channel. <= 150 characters.
  6. Output ONLY the JSON object.`;

export interface DiscoverFromInterestsArgs {
  workspaceId: string;
  interests: readonly string[];
  language?: string;
  region?: string;
  fit?: OperatorFit;
  force?: boolean;
}

export interface DiscoverFromInterestsResult {
  discovery: NicheDiscoveryRow;
  cached: boolean;
  /** Whether the AI proposed a viable candidate list. If false the
   *  UI surfaces a "couldn't generate ideas" message instead of an
   *  empty grid. */
  candidatesOk: boolean;
}

const DEFAULT_FIT: OperatorFit = {
  interests: [],
  language: 'en',
  region: 'US',
  llmFitScore: 0.5,
  llmRationale: 'No fit input provided; defaulting to a neutral read.',
};

const CANDIDATES_TARGET = 8;
const MAX_VIDEOS_PER_CLUSTER = 30;

interface CandidateNiche {
  name: string;
  rationale: string;
}

/** Parse strict-JSON AI output. Returns null when output is
 *  unparseable. Exported for unit tests. */
export function parseCandidatesOutput(raw: string): CandidateNiche[] | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const nichesField = (parsed as { niches?: unknown }).niches;
  if (!Array.isArray(nichesField)) return null;

  const out: CandidateNiche[] = [];
  const seen = new Set<string>();
  for (const item of nichesField) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { name?: unknown; rationale?: unknown };
    if (typeof obj.name !== 'string') continue;
    const name = obj.name.trim();
    if (name.length === 0 || name.length > 100) continue;
    const slug = name.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 200) : '';
    out.push({ name, rationale });
    if (out.length >= CANDIDATES_TARGET) break;
  }
  if (out.length === 0) return null;
  return out;
}

/** Build a `ClusterSample` from raw YouTube fetch output. */
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

export async function discoverFromInterests(
  args: DiscoverFromInterestsArgs,
): Promise<DiscoverFromInterestsResult> {
  const fit = args.fit ?? DEFAULT_FIT;
  const language = args.language ?? fit.language ?? 'en';
  const region = args.region ?? fit.region ?? 'US';
  const inputHash = hashDiscoveryInput(
    `${canonicaliseInterests(args.interests)}|${language}|${region}`,
  );
  const summary = `Interests: ${args.interests.join(', ').slice(0, 150)}`;

  // Cache check.
  if (!args.force) {
    const cached = await getDiscovery({
      workspaceId: args.workspaceId,
      kind: 'interests',
      inputHash,
    });
    if (cached) {
      return { discovery: cached, cached: true, candidatesOk: cached.results.length > 0 };
    }
  }

  const spendContext: AiSpendContext = {
    workspaceId: args.workspaceId,
    featureArea: 'niche_finder.discover_from_interests',
  };

  // Step 1: AI candidate niches.
  const modelId = await getEffectiveModelId(args.workspaceId, 'niche-cluster-map');
  const userPrompt = `Interests: ${args.interests.join('; ')}
Language: ${language}
Region: ${region}

Propose 8 niches per the system rules.`;

  let raw = '';
  try {
    raw = await generateText({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      prompt: userPrompt,
      maxTokens: 1200,
      temperature: 0.5,
      cache: true,
      spend: spendContext,
    });
  } catch (err) {
    logger.warn('niche-finder discoverFromInterests: AI failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const candidates = parseCandidatesOutput(raw);
  if (!candidates || candidates.length === 0) {
    return {
      discovery: {
        id: '',
        workspace_id: args.workspaceId,
        kind: 'interests',
        input_hash: inputHash,
        input_summary: summary,
        results: [],
        created_at: new Date().toISOString(),
      },
      cached: false,
      candidatesOk: false,
    };
  }

  // Step 2: score each candidate.
  const results: DiscoveryResultItem[] = [];
  for (const candidate of candidates) {
    const { videos, channels } = await harvestClusterSample(candidate.name, {
      maxVideos: MAX_VIDEOS_PER_CLUSTER,
      regionCode: region,
      relevanceLanguage: language,
    });
    if (videos.length === 0) {
      // YouTube returned nothing for this candidate — skip rather
      // than emit a zero-score row that would just confuse the user.
      continue;
    }
    const sample = buildSample(candidate.name, videos, channels);
    const demand = scoreDemand(sample, 0);
    const supply = scoreSupply(sample);
    const monetization = scoreMonetization(sample, candidate.name);
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
      slug: slugifyNiche(candidate.name),
      name: normalizeNicheName(candidate.name),
      rationale: candidate.rationale,
      scores: rolled,
    });
  }

  results.sort((a, b) => b.scores.combined - a.scores.combined);

  const row = await upsertDiscovery({
    workspaceId: args.workspaceId,
    kind: 'interests',
    inputHash,
    inputSummary: summary,
    results,
  });

  return { discovery: row, cached: false, candidatesOk: true };
}
