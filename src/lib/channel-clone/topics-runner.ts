/**
 * Channel-clone topics runner — V2.0 STATE 5.
 *
 * Generates 10 ranked topic ideas for the cloned channel based on
 * the deep analysis output. Each topic carries:
 *   - title (curiosity-gap)
 *   - angle (one-line)
 *   - hook (one-line)
 *   - difficulty (1-10)
 *
 * Persists onto `state_jsonb.topics` and bumps the job status to
 * `topics_complete`. The user then picks a topic by sending the
 * index to the hooks runner.
 */

import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import { getChannelCloneSystemPrompt } from './prompts/v2-content-engine';
import type { ChannelCloneJobState } from './types';

const TOPICS_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "topics": [
    { "title": string, "angle": string, "hook": string, "difficulty": number }
  ]
}

Constraints:
- Return EXACTLY the number of topics requested.
- "title" is curiosity-gap, 4-12 words, no clickbait punctuation other than "?".
- "angle" is a one-line description of the take/structure.
- "hook" is the opening line as it would be spoken.
- "difficulty" is an integer 1-10 where 1 = easy to make, 10 = research-heavy.
- Ranked best→worst by predicted retention strength.

Output ONLY the JSON object. No prose, no markdown fences. First char \`{\`, last char \`}\`.`;

export interface ChannelCloneTopic {
  title: string;
  angle: string;
  hook: string;
  difficulty: number;
}

export interface RunTopicsOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  /** How many topics to ask for. Defaults to 10 per V2.0 STATE 5. */
  topicCount?: number;
  /** Per-invocation model override. See `RunAnalyzeOptions.modelOverride`. */
  modelOverride?: string;
}

export async function runTopics(opts: RunTopicsOptions): Promise<void> {
  const { jobId, workspaceId } = opts;
  const topicCount = opts.topicCount ?? 10;
  logger.info('[channel-clone topics] start', { jobId, topicCount });
  await setChannelCloneJobStatus(jobId, workspaceId, 'topics_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone topics] job missing', { jobId });
    return;
  }
  const analysis = job.state_jsonb.analysis;
  if (!analysis) {
    return failJob(jobId, workspaceId, 'Cannot generate topics: analysis is not complete.');
  }

  const modelId = opts.modelOverride ?? await getEffectiveModelId(workspaceId, 'channel-clone-topic-generation');
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-topic-generation') + '\n\n' + TOPICS_OUTPUT_SCHEMA;
  const userPrompt = buildTopicsUserPrompt(analysis, topicCount);

  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt,
      prompt: userPrompt,
      maxTokens: 4000,
      temperature: 0.85,
      spend: {
        workspaceId,
        projectId: opts.projectId ?? null,
        featureArea: 'channel_clone_topics',
        metadata: { jobId, topicCount },
      },
    });
  } catch (err) {
    return failJob(jobId, workspaceId, `Model call failed: ${errorMessage(err)}`);
  }

  let topics: ChannelCloneTopic[];
  try {
    topics = parseTopicsResponse(raw, topicCount);
  } catch (err) {
    logger.error('[channel-clone topics] parse failed', {
      jobId,
      modelId,
      rawPreview: raw.slice(0, 400),
      error: errorMessage(err),
    });
    return failJob(jobId, workspaceId, `Could not parse topics output: ${errorMessage(err)}`);
  }

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    topics,
    // Reset downstream state if the user is regenerating topics
    // after a previous run.
    selectedTopicIndex: undefined,
    hooks: undefined,
    selectedHookIndex: undefined,
    scriptDraft: undefined,
    auditHistory: undefined,
    approvedScript: undefined,
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'topics_complete');
  logger.info('[channel-clone topics] done', { jobId, modelId, topicCount: topics.length });
}

function buildTopicsUserPrompt(
  analysis: NonNullable<ChannelCloneJobState['analysis']>,
  topicCount: number,
): string {
  return [
    `You are now at STATE 5. Generate ${topicCount} topic ideas for the cloned channel.`,
    '',
    'Channel context (from the deep analysis stage):',
    `- Niche: ${analysis.niche} / ${analysis.subNiche}`,
    `- Content format: ${analysis.contentFormat}`,
    `- Target audience (demographics): ${analysis.targetAudience.demographics}`,
    `- Target audience (psychographics): ${analysis.targetAudience.psychographics}`,
    `- Hook architecture: ${analysis.hookArchitecture}`,
    `- Script flow blueprint: ${analysis.scriptFlowBlueprint}`,
    `- Audience pain points: ${analysis.audiencePsychology.painPoints.join(', ')}`,
    `- Channel's enemy: ${analysis.audiencePsychology.channelsEnemy}`,
    `- Identity promise: ${analysis.audiencePsychology.identityPromise}`,
    `- Signature phrases: ${analysis.signaturePhrases.join(' | ')}`,
    `- Words-per-second pacing: ${analysis.wpsEstimate.toFixed(2)}`,
    `- Average video length: ~${analysis.avgVideoWordCount} words`,
    '',
    'Generate topics that fit this DNA — match the curiosity-gap pattern, the audience psychology, and the format. Rank best-first.',
  ].join('\n');
}

/** Parse the model's response into a typed topics array. Exported
 *  for unit tests. */
export function parseTopicsResponse(raw: string, expectedCount: number): ChannelCloneTopic[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const obj = JSON.parse(cleaned) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;
  const arr = o.topics;
  if (!Array.isArray(arr)) throw new Error('topics must be an array');
  if (arr.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} topics, got ${arr.length}`);
  }
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`topics[${i}] is not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== 'string' || e.title.length === 0) throw new Error(`topics[${i}].title must be a non-empty string`);
    if (typeof e.angle !== 'string' || e.angle.length === 0) throw new Error(`topics[${i}].angle must be a non-empty string`);
    if (typeof e.hook !== 'string' || e.hook.length === 0) throw new Error(`topics[${i}].hook must be a non-empty string`);
    if (typeof e.difficulty !== 'number' || !Number.isInteger(e.difficulty) || e.difficulty < 1 || e.difficulty > 10) {
      throw new Error(`topics[${i}].difficulty must be an integer 1-10`);
    }
    return { title: e.title, angle: e.angle, hook: e.hook, difficulty: e.difficulty };
  });
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone topics] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'topics_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
