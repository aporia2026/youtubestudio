/**
 * Channel-clone publish-pack runner — V2.0 STATEs 18 + 19 + 21.
 *
 * Generates the full launch packaging for a finished video in a
 * single LLM call:
 *   - 5 thumbnail concepts (visual + text overlay + emotion trigger
 *     + colour contrast + standalone prompt + CTR reasoning).
 *   - 5 title candidates ranked by predicted CTR.
 *   - Full description + ~30 SEO tags + 3 pinned-comment options
 *     + category recommendation + optimal upload time.
 *   - 30-day content calendar with title, angle, difficulty, best
 *     upload time, and content pillar per day.
 *
 * One call instead of three because the calendar's coherence with
 * the just-approved script + chosen niche depends on the same
 * context the thumbnail and SEO stages need anyway. Cheaper, more
 * consistent, and the user can re-run if any one piece misses.
 */

import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import { extractJsonObjectFromModelResponse } from './parse-llm-json';
import { getBuiltInStyle } from '@/lib/production-doc-styles';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import { getChannelCloneSystemPrompt } from './prompts/v2-content-engine';
import type { ChannelCloneJobState } from './types';

const PUBLISH_PACK_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "titles": [
    { "text": string, "ctrReasoning": string }    // EXACTLY 5 items, ranked best-first
  ],
  "description": string,                          // Full YouTube description, 200-600 words, includes a hook line at the top, 2-3 paragraphs of content tease, then optional links/CTAs
  "tags": string[],                               // EXACTLY 30 lowercase comma-free tags
  "pinnedCommentOptions": [string, string, string], // EXACTLY 3 candidate pinned comments, each engagement-bait that matches the channel's voice
  "categoryRecommendation": string,               // One of YouTube's categories (e.g. "Education", "Science & Technology", "People & Blogs")
  "optimalUploadTime": string,                    // Free-form, e.g. "Tuesday 4pm ET" or "weekday late afternoon"
  "similarChannelNames": [
    {
      "name": string,                             // Real or invented channel name that sits in the same niche neighbourhood
      "reasoning": string                         // 1 sentence — why this name fits the cloned channel's audience + voice
    }
    // EXACTLY 8 items. Prefer well-known REAL channels when the niche has them; invent plausible ones to fill in.
  ],
  "thumbnailConcepts": [
    {
      "visualConcept": string,                    // 1 sentence describing what the viewer sees
      "textOverlay": string,                      // 4-6 words MAX, matches the channel's thumbnail style
      "emotionTrigger": string,                   // Curiosity, fear, outrage, awe, etc.
      "colorContrastStrategy": string,
      "fullImagePrompt": string,                  // STANDALONE prompt, includes the chosen style's suffix
      "ctrReasoning": string                      // Why this concept earns the click
    }
    // EXACTLY 5 items, ranked best-first
  ],
  "contentCalendar": [
    {
      "day": number,                              // 1..30
      "title": string,
      "angle": string,
      "difficulty": number,                       // 1-10 integer
      "bestUploadTime": string,
      "contentPillar": string                     // e.g. "audience pain point", "evergreen explainer", "trend hijack"
    }
    // EXACTLY 30 items, day=1..30 strictly increasing
  ]
}

Constraints:
- Titles must be curiosity-gap, 4-12 words, no clickbait punctuation other than "?".
- Tags lowercase, no leading "#", no commas inside a tag.
- Thumbnail concepts MUST reference the channel's signature palette + the style preset's visual identity.
- Calendar variety: do not repeat angles; rotate through the channel's known pain points.
- similarChannelNames: list 8 channels (real or invented) that target the SAME audience + niche as the cloned source. Aim for a mix — at least 3 should be real channels the audience would recognise; the rest can be plausible inventions for niches without obvious peers. Each "reasoning" is ONE sentence describing the overlap (audience, format, voice, visual style).

Output ONLY the JSON object. First char \`{\`, last char \`}\`. No prose, no fences.`;

export interface RunPublishPackOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  /** Per-invocation model override. See `RunAnalyzeOptions.modelOverride`. */
  modelOverride?: string;
}

export async function runPublishPack(opts: RunPublishPackOptions): Promise<void> {
  const { jobId, workspaceId } = opts;
  logger.info('[channel-clone publish-pack] start', { jobId });
  await setChannelCloneJobStatus(jobId, workspaceId, 'publish_pack_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone publish-pack] job missing', { jobId });
    return;
  }
  const { analysis, topics, hooks, selectedTopicIndex, selectedHookIndex, approvedScript, chosenStylePresetId } = job.state_jsonb;
  if (!analysis || !approvedScript || !topics || !hooks || !selectedTopicIndex || !selectedHookIndex) {
    return failJob(jobId, workspaceId, 'Cannot generate publish pack: full prior context (analysis + topic + hook + approvedScript) is required.');
  }
  const topic = topics[selectedTopicIndex - 1];
  const hook = hooks[selectedHookIndex - 1];

  const modelId = opts.modelOverride ?? await getEffectiveModelId(workspaceId, 'channel-clone-publish-pack');
  const preset = chosenStylePresetId ? getBuiltInStyle(chosenStylePresetId) : null;
  const systemPrompt = [
    getChannelCloneSystemPrompt('channel-clone-publish-pack'),
    '',
    preset
      ? `Chosen style preset for thumbnails: ${preset.label} (id: ${preset.id}). Include this suffix verbatim at the end of every thumbnailConcepts[].fullImagePrompt:\n${preset.ai_image_suffix}`
      : 'No style preset was chosen — produce thumbnail prompts in a clean, modern explainer style.',
    '',
    PUBLISH_PACK_OUTPUT_SCHEMA,
  ].join('\n\n');

  const userPrompt = buildPublishPackUserPrompt(analysis, topic, hook, approvedScript);

  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt,
      prompt: userPrompt,
      // The output is heavy (5 titles + description + 30 tags +
      // 3 comments + 5 thumbnails + 30 calendar days). QA pass
      // 2026-06-05 raised this from 12000 → 16000 after the worst
      // case (description 600+ words + verbose ctrReasoning across
      // every thumbnail + verbose calendar entries) was estimated
      // to truncate at 12K with `temperature: 0.7`. The exact-
      // count parser at parsePublishPackResponse refuses to accept
      // a partial calendar, so even one truncation kills the whole
      // pack — easier to overshoot the budget than to retry.
      maxTokens: 16000,
      temperature: 0.7,
      spend: {
        workspaceId,
        projectId: opts.projectId ?? null,
        featureArea: 'channel_clone_publish_pack',
        metadata: { jobId },
      },
    });
  } catch (err) {
    return failJob(jobId, workspaceId, `Model call failed: ${errorMessage(err)}`);
  }

  let parsed: NonNullable<ChannelCloneJobState['publishPack']>;
  try {
    parsed = parsePublishPackResponse(raw, modelId);
  } catch (err) {
    logger.error('[channel-clone publish-pack] parse failed', {
      jobId,
      modelId,
      rawPreview: raw.slice(0, 400),
      error: errorMessage(err),
    });
    return failJob(jobId, workspaceId, `Could not parse publish pack: ${errorMessage(err)}`);
  }

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    publishPack: parsed,
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'publish_pack_complete');
  logger.info('[channel-clone publish-pack] done', {
    jobId,
    modelId,
    titles: parsed.titles.length,
    tags: parsed.tags.length,
    thumbnails: parsed.thumbnailConcepts.length,
    calendarDays: parsed.contentCalendar.length,
    similarChannels: parsed.similarChannelNames.length,
  });
}

function buildPublishPackUserPrompt(
  analysis: NonNullable<ChannelCloneJobState['analysis']>,
  topic: NonNullable<ChannelCloneJobState['topics']>[number],
  hook: NonNullable<ChannelCloneJobState['hooks']>[number],
  approvedScript: NonNullable<ChannelCloneJobState['approvedScript']>,
): string {
  return [
    'You are running STATEs 18 + 19 + 21 in one shot for the just-approved video.',
    '',
    `Channel niche: ${analysis.niche} / ${analysis.subNiche}`,
    `Channel target audience: ${analysis.targetAudience.demographics} — ${analysis.targetAudience.psychographics}`,
    `Channel WPS: ${analysis.wpsEstimate.toFixed(2)} (use for calendar bestUploadTime context).`,
    `Identity promise: ${analysis.audiencePsychology.identityPromise}`,
    `Channel's enemy: ${analysis.audiencePsychology.channelsEnemy}`,
    `Audience pain points: ${analysis.audiencePsychology.painPoints.join(', ')}`,
    `Signature phrases: ${analysis.signaturePhrases.join(' | ')}`,
    '',
    `Topic of this video: ${topic.title}`,
    `Angle: ${topic.angle}`,
    `Hook archetype used: ${hook.archetype}`,
    `Approved script word count: ${approvedScript.wordCount}`,
    '',
    'Approved script:',
    approvedScript.text,
    '',
    'Now produce the publish pack per the schema. Thumbnails should ride the visual style; the calendar should rotate through the audience pain points without repeating angles.',
  ].join('\n');
}

/** Parse the model's response into a fully-typed publishPack
 *  object. Exported for unit tests. */
export function parsePublishPackResponse(
  raw: string,
  modelId: string,
): NonNullable<ChannelCloneJobState['publishPack']> {
  const obj = extractJsonObjectFromModelResponse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;

  // Titles
  const titles = asArrayOfObjects(o.titles, 'titles', 5).map((t, i) => ({
    text: asString(t.text, `titles[${i}].text`),
    ctrReasoning: asString(t.ctrReasoning, `titles[${i}].ctrReasoning`),
  }));

  // Description
  const description = asString(o.description, 'description');
  if (description.length < 100) throw new Error('description must be at least 100 chars');

  // Tags
  const tags = asStringArray(o.tags, 'tags');
  if (tags.length < 20 || tags.length > 40) {
    throw new Error(`tags must contain 20-40 entries (got ${tags.length})`);
  }

  // Pinned comments
  const pinnedCommentOptions = asStringArray(o.pinnedCommentOptions, 'pinnedCommentOptions');
  if (pinnedCommentOptions.length !== 3) {
    throw new Error(`pinnedCommentOptions must contain exactly 3 entries (got ${pinnedCommentOptions.length})`);
  }

  // Category + upload time
  const categoryRecommendation = asString(o.categoryRecommendation, 'categoryRecommendation');
  const optimalUploadTime = asString(o.optimalUploadTime, 'optimalUploadTime');

  // Similar channel names — 8 entries, each { name, reasoning }
  const similarChannelNames = asArrayOfObjects(o.similarChannelNames, 'similarChannelNames', 8).map((s, i) => ({
    name: asString(s.name, `similarChannelNames[${i}].name`),
    reasoning: asString(s.reasoning, `similarChannelNames[${i}].reasoning`),
  }));

  // Thumbnails
  const thumbnailConcepts = asArrayOfObjects(o.thumbnailConcepts, 'thumbnailConcepts', 5).map((t, i) => ({
    visualConcept: asString(t.visualConcept, `thumbnailConcepts[${i}].visualConcept`),
    textOverlay: asString(t.textOverlay, `thumbnailConcepts[${i}].textOverlay`),
    emotionTrigger: asString(t.emotionTrigger, `thumbnailConcepts[${i}].emotionTrigger`),
    colorContrastStrategy: asString(t.colorContrastStrategy, `thumbnailConcepts[${i}].colorContrastStrategy`),
    fullImagePrompt: asString(t.fullImagePrompt, `thumbnailConcepts[${i}].fullImagePrompt`),
    ctrReasoning: asString(t.ctrReasoning, `thumbnailConcepts[${i}].ctrReasoning`),
  }));

  // Calendar — 30 days, strictly increasing days
  const calendar = asArrayOfObjects(o.contentCalendar, 'contentCalendar', 30).map((c, i) => {
    const day = asNumber(c.day, `contentCalendar[${i}].day`);
    if (!Number.isInteger(day) || day < 1 || day > 30) {
      throw new Error(`contentCalendar[${i}].day must be an integer 1-30`);
    }
    const difficulty = asNumber(c.difficulty, `contentCalendar[${i}].difficulty`);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 10) {
      throw new Error(`contentCalendar[${i}].difficulty must be an integer 1-10`);
    }
    return {
      day,
      title: asString(c.title, `contentCalendar[${i}].title`),
      angle: asString(c.angle, `contentCalendar[${i}].angle`),
      difficulty,
      bestUploadTime: asString(c.bestUploadTime, `contentCalendar[${i}].bestUploadTime`),
      contentPillar: asString(c.contentPillar, `contentCalendar[${i}].contentPillar`),
    };
  });
  // Check days monotonically increasing 1..30.
  for (let i = 0; i < calendar.length; i++) {
    if (calendar[i].day !== i + 1) {
      throw new Error(`contentCalendar must list days 1..30 in order (entry ${i} has day=${calendar[i].day})`);
    }
  }

  return {
    titles,
    description,
    tags,
    pinnedCommentOptions: [pinnedCommentOptions[0], pinnedCommentOptions[1], pinnedCommentOptions[2]],
    categoryRecommendation,
    optimalUploadTime,
    similarChannelNames,
    thumbnailConcepts,
    contentCalendar: calendar,
    modelUsed: modelId,
    generatedAt: new Date().toISOString(),
  };
}

// ─── tiny shared validators ─────────────────────────────────────────

function asString(v: unknown, key: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${key} must be a non-empty string`);
  return v;
}
function asNumber(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${key} must be a finite number`);
  return v;
}
function asStringArray(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${key} must be a string array`);
  }
  return v as string[];
}
function asArrayOfObjects(v: unknown, key: string, expectedLength: number): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw new Error(`${key} must be an array`);
  if (v.length !== expectedLength) throw new Error(`${key} must contain exactly ${expectedLength} entries (got ${v.length})`);
  for (let i = 0; i < v.length; i++) {
    if (!v[i] || typeof v[i] !== 'object') throw new Error(`${key}[${i}] must be an object`);
  }
  return v as Record<string, unknown>[];
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone publish-pack] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'publish_pack_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
