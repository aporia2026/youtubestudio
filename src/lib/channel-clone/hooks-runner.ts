/**
 * Channel-clone hooks runner — V2.0 STATE 9.
 *
 * Given a selected topic, generates 5 hook archetypes (Contrarian /
 * Story / Stat / Challenge / Mystery). Each carries a spoken
 * duration estimate computed from the channel's WPS so we can
 * sanity-check pacing before script generation.
 *
 * Persists onto `state_jsonb.hooks` + `selectedTopicIndex`, bumps
 * status to `hooks_complete`. The user then picks a hook index and
 * the script runner takes over.
 */

import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import { extractJsonObjectFromModelResponse } from './parse-llm-json';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import { getChannelCloneSystemPrompt } from './prompts/v2-content-engine';
import type { ChannelCloneJobState } from './types';

const HOOKS_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "hooks": [
    { "archetype": "Contrarian" | "Story" | "Stat" | "Challenge" | "Mystery",
      "text": string,
      "wordCount": number,
      "estimatedDurationSec": number }
  ]
}

Constraints:
- Return EXACTLY 5 hooks.
- One per archetype, in the order: Contrarian, Story, Stat, Challenge, Mystery.
- "text" is the spoken hook — full sentences, no headings, no quotes around it.
- "wordCount" is your honest word count of the text.
- "estimatedDurationSec" = wordCount / (channel WPS supplied below), rounded to 1 decimal.
- Each hook is 15-30 seconds when spoken at the channel's pacing.

Output ONLY the JSON object. First char \`{\`, last char \`}\`.`;

export interface ChannelCloneHook {
  archetype: 'Contrarian' | 'Story' | 'Stat' | 'Challenge' | 'Mystery';
  text: string;
  wordCount: number;
  estimatedDurationSec: number;
}

export interface RunHooksOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  /** 1-based topic index the user picked from the topics list. */
  selectedTopicIndex: number;
  /** Per-invocation model override. See `RunAnalyzeOptions.modelOverride`. */
  modelOverride?: string;
}

export async function runHooks(opts: RunHooksOptions): Promise<void> {
  const { jobId, workspaceId, selectedTopicIndex } = opts;
  logger.info('[channel-clone hooks] start', { jobId, selectedTopicIndex });
  await setChannelCloneJobStatus(jobId, workspaceId, 'hooks_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone hooks] job missing', { jobId });
    return;
  }
  const { analysis, topics } = job.state_jsonb;
  if (!analysis || !topics || topics.length === 0) {
    return failJob(jobId, workspaceId, 'Cannot generate hooks: analysis + topics must be complete.');
  }
  if (selectedTopicIndex < 1 || selectedTopicIndex > topics.length) {
    return failJob(jobId, workspaceId, `selectedTopicIndex ${selectedTopicIndex} is out of range (1-${topics.length}).`);
  }

  const topic = topics[selectedTopicIndex - 1];
  const modelId = opts.modelOverride ?? await getEffectiveModelId(workspaceId, 'channel-clone-hook-engineering');
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-hook-engineering') + '\n\n' + HOOKS_OUTPUT_SCHEMA;
  const userPrompt = buildHooksUserPrompt(analysis, topic);

  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt,
      prompt: userPrompt,
      maxTokens: 2500,
      temperature: 0.8,
      spend: {
        workspaceId,
        projectId: opts.projectId ?? null,
        featureArea: 'channel_clone_hooks',
        metadata: { jobId, selectedTopicIndex },
      },
    });
  } catch (err) {
    return failJob(jobId, workspaceId, `Model call failed: ${errorMessage(err)}`);
  }

  let hooks: ChannelCloneHook[];
  try {
    hooks = parseHooksResponse(raw);
  } catch (err) {
    logger.error('[channel-clone hooks] parse failed', {
      jobId,
      modelId,
      rawPreview: raw.slice(0, 400),
      error: errorMessage(err),
    });
    return failJob(jobId, workspaceId, `Could not parse hooks output: ${errorMessage(err)}`);
  }

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    selectedTopicIndex,
    hooks,
    // Reset downstream state on regeneration.
    selectedHookIndex: undefined,
    scriptDraft: undefined,
    auditHistory: undefined,
    approvedScript: undefined,
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'hooks_complete');
  logger.info('[channel-clone hooks] done', {
    jobId,
    modelId,
    selectedTopicIndex,
    archetypes: hooks.map((h) => h.archetype),
  });
}

function buildHooksUserPrompt(
  analysis: NonNullable<ChannelCloneJobState['analysis']>,
  topic: NonNullable<ChannelCloneJobState['topics']>[number],
): string {
  return [
    'You are now at STATE 9. Generate 5 hooks for the selected topic, one per archetype.',
    '',
    `Selected topic: "${topic.title}"`,
    `Topic angle: ${topic.angle}`,
    `Seed hook line (do NOT reuse verbatim — use as a starting reference): ${topic.hook}`,
    '',
    `Channel WPS: ${analysis.wpsEstimate.toFixed(2)}`,
    `Channel signature phrases (rhythmically compatible patterns): ${analysis.signaturePhrases.join(' | ')}`,
    `Channel hook architecture: ${analysis.hookArchitecture}`,
    `Tonal fingerprint: ${analysis.styleDna.tonalFingerprint}`,
    `Opening patterns: ${analysis.styleDna.openingPatterns}`,
    '',
    'Each hook must be a fully-formed spoken open — no headings, no bullet points, no "Hook:" prefix. Match the channel\'s rhythm exactly.',
  ].join('\n');
}

const HOOK_ARCHETYPE_ORDER: ChannelCloneHook['archetype'][] = ['Contrarian', 'Story', 'Stat', 'Challenge', 'Mystery'];

/** Parse the model's response into 5 typed hooks. Exported for unit tests. */
export function parseHooksResponse(raw: string): ChannelCloneHook[] {
  const obj = extractJsonObjectFromModelResponse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const arr = (obj as Record<string, unknown>).hooks;
  if (!Array.isArray(arr)) throw new Error('hooks must be an array');
  if (arr.length !== 5) throw new Error(`expected 5 hooks, got ${arr.length}`);
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`hooks[${i}] is not an object`);
    const e = entry as Record<string, unknown>;
    const archetype = e.archetype;
    if (typeof archetype !== 'string' || !HOOK_ARCHETYPE_ORDER.includes(archetype as ChannelCloneHook['archetype'])) {
      throw new Error(`hooks[${i}].archetype must be one of ${HOOK_ARCHETYPE_ORDER.join(', ')}`);
    }
    if (typeof e.text !== 'string' || e.text.length === 0) throw new Error(`hooks[${i}].text must be a non-empty string`);
    if (typeof e.wordCount !== 'number' || !Number.isFinite(e.wordCount) || e.wordCount < 1) {
      throw new Error(`hooks[${i}].wordCount must be a positive number`);
    }
    if (typeof e.estimatedDurationSec !== 'number' || !Number.isFinite(e.estimatedDurationSec) || e.estimatedDurationSec <= 0) {
      throw new Error(`hooks[${i}].estimatedDurationSec must be a positive number`);
    }
    return {
      archetype: archetype as ChannelCloneHook['archetype'],
      text: e.text,
      wordCount: e.wordCount,
      estimatedDurationSec: e.estimatedDurationSec,
    };
  });
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone hooks] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'hooks_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
