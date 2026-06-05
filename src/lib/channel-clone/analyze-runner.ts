/**
 * Channel-clone analyze runner.
 *
 * Takes a job whose intake is complete and runs the deep channel
 * analysis stage. Composition:
 *
 *   System prompt = V2.0 PREAMBLE
 *                 + STATE 6 (Deep Channel Analysis)
 *                 + STATE 7 (Style DNA)
 *                 + STATE 8 (Audience Psychology)
 *                 + STATE 13 (Visual Style Analysis)
 *                 + ABSOLUTE RULES
 *                 + a strict JSON-output schema
 *
 *   User prompt  = "Analyze this channel. Here are N transcripts:" + concatenated transcripts
 *                + "Return JSON matching the schema. No prose, no markdown fences."
 *
 * The model is whatever the user picked for `channel-clone-analyze`
 * in Settings → Model Defaults; default is Opus 4.8. Visual style
 * analysis from frames is deferred to M2 — for v1 the analysis is
 * text-only over the cleaned transcripts.
 *
 * Output lands on the job's `state_jsonb.analysis`. On failure the
 * job status moves to `analyze_failed` and the parsed error is on
 * `last_error`.
 */

import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import {
  getChannelCloneSystemPrompt,
} from './prompts/v2-content-engine';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import type { ChannelCloneAnalysis } from './types';

const ANALYSIS_OUTPUT_SCHEMA_INSTRUCTION = `Respond with a single JSON object matching this TypeScript shape exactly:
{
  "niche": string,                                 // primary niche, 2-4 words
  "subNiche": string,                              // sub-niche, 2-6 words
  "targetAudience": { "demographics": string, "psychographics": string },
  "contentFormat": "essay" | "listicle" | "story" | "tutorial" | "hybrid",
  "hookArchitecture": string,                      // 1-3 sentences describing the hook pattern
  "scriptFlowBlueprint": string,                   // 2-4 sentences describing the script structure
  "wpsEstimate": number,                           // words per second, 2 decimals
  "avgVideoWordCount": number,                     // average across the supplied transcripts
  "signaturePhrases": string[],                    // 3-8 recurring phrases or sentence patterns
  "styleDna": {
    "sentenceRhythm": string,
    "tonalFingerprint": string,
    "transitionMechanics": string,
    "metaphorPatterns": string,
    "openingPatterns": string,
    "closingPatterns": string
  },
  "audiencePsychology": {
    "painPoints": string[],
    "identityPromise": string,
    "channelsEnemy": string
  }
}

Output ONLY the JSON object. No prose before or after. No markdown code fences. No explanation. The first character of your response MUST be \`{\` and the last must be \`}\`.`;

export interface RunAnalyzeOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
}

export async function runAnalyze(opts: RunAnalyzeOptions): Promise<void> {
  const { jobId, workspaceId } = opts;
  logger.info('[channel-clone analyze] start', { jobId });
  await setChannelCloneJobStatus(jobId, workspaceId, 'analyze_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone analyze] job missing', { jobId });
    return;
  }
  const intake = job.state_jsonb.intake;
  if (!intake) {
    return failJob(jobId, workspaceId, 'Cannot analyze: intake is not complete.');
  }
  const transcripts = intake.sampleVideos
    .map((v, i) => (v.transcript ? { i, title: v.title, text: linesToText(v.transcript.lines) } : null))
    .filter(Boolean) as { i: number; title: string; text: string }[];
  if (transcripts.length === 0) {
    return failJob(jobId, workspaceId, 'No usable transcripts on the intake — nothing to analyze.');
  }

  const modelId = await getEffectiveModelId(workspaceId, 'channel-clone-analyze');
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-analyze') + '\n\n' + ANALYSIS_OUTPUT_SCHEMA_INSTRUCTION;
  const userPrompt = buildAnalyzeUserPrompt(transcripts);

  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt,
      prompt: userPrompt,
      maxTokens: 6000,
      temperature: 0.4,
      spend: {
        workspaceId,
        projectId: opts.projectId ?? null,
        featureArea: 'channel_clone_analyze',
        metadata: { jobId, transcriptCount: transcripts.length },
      },
    });
  } catch (err) {
    return failJob(jobId, workspaceId, `Model call failed: ${errorMessage(err)}`);
  }

  let parsed: ChannelCloneAnalysis;
  try {
    parsed = parseAnalyzeResponse(raw, modelId);
  } catch (err) {
    logger.error('[channel-clone analyze] parse failed', {
      jobId,
      modelId,
      rawPreview: raw.slice(0, 400),
      error: errorMessage(err),
    });
    return failJob(jobId, workspaceId, `Could not parse analysis output: ${errorMessage(err)}`);
  }

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) {
    logger.error('[channel-clone analyze] job vanished mid-run', { jobId });
    return;
  }
  const nextState = { ...fresh.state_jsonb, analysis: parsed };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'analyze_complete');
  logger.info('[channel-clone analyze] done', {
    jobId,
    modelId,
    niche: parsed.niche,
    wps: parsed.wpsEstimate,
    avgWords: parsed.avgVideoWordCount,
    signaturePhraseCount: parsed.signaturePhrases.length,
  });
}

function buildAnalyzeUserPrompt(transcripts: { i: number; title: string; text: string }[]): string {
  const blocks = transcripts.map(
    (t) => `# Transcript T${t.i + 1}: ${t.title}\n\n${t.text}`,
  );
  return [
    'You are now at STATE 6 → 7 → 8 → 13 of the workflow.',
    `The user has supplied ${transcripts.length} full transcripts from this channel.`,
    'Perform the deep channel analysis, style DNA extraction, audience psychology profile, and visual style analysis on the basis of these transcripts.',
    '',
    'Transcripts:',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

function linesToText(lines: { text: string }[]): string {
  return lines.map((l) => l.text).join(' ');
}

/** Parse the model's raw JSON response into a strongly-typed
 *  ChannelCloneAnalysis. Throws when the shape is missing required
 *  fields or carries invalid enum values. Exported for unit tests
 *  in `tests/channel-clone-analyze-parser.test.ts`. */
export function parseAnalyzeResponse(raw: string, modelId: string): ChannelCloneAnalysis {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const obj = JSON.parse(cleaned) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;

  return {
    niche: asString(o.niche, 'niche'),
    subNiche: asString(o.subNiche, 'subNiche'),
    targetAudience: {
      demographics: asString((o.targetAudience as Record<string, unknown>)?.demographics, 'targetAudience.demographics'),
      psychographics: asString((o.targetAudience as Record<string, unknown>)?.psychographics, 'targetAudience.psychographics'),
    },
    contentFormat: asContentFormat(o.contentFormat),
    hookArchitecture: asString(o.hookArchitecture, 'hookArchitecture'),
    scriptFlowBlueprint: asString(o.scriptFlowBlueprint, 'scriptFlowBlueprint'),
    wpsEstimate: asNumber(o.wpsEstimate, 'wpsEstimate'),
    avgVideoWordCount: asNumber(o.avgVideoWordCount, 'avgVideoWordCount'),
    signaturePhrases: asStringArray(o.signaturePhrases, 'signaturePhrases'),
    styleDna: {
      sentenceRhythm: asString((o.styleDna as Record<string, unknown>)?.sentenceRhythm, 'styleDna.sentenceRhythm'),
      tonalFingerprint: asString((o.styleDna as Record<string, unknown>)?.tonalFingerprint, 'styleDna.tonalFingerprint'),
      transitionMechanics: asString((o.styleDna as Record<string, unknown>)?.transitionMechanics, 'styleDna.transitionMechanics'),
      metaphorPatterns: asString((o.styleDna as Record<string, unknown>)?.metaphorPatterns, 'styleDna.metaphorPatterns'),
      openingPatterns: asString((o.styleDna as Record<string, unknown>)?.openingPatterns, 'styleDna.openingPatterns'),
      closingPatterns: asString((o.styleDna as Record<string, unknown>)?.closingPatterns, 'styleDna.closingPatterns'),
    },
    audiencePsychology: {
      painPoints: asStringArray((o.audiencePsychology as Record<string, unknown>)?.painPoints, 'audiencePsychology.painPoints'),
      identityPromise: asString((o.audiencePsychology as Record<string, unknown>)?.identityPromise, 'audiencePsychology.identityPromise'),
      channelsEnemy: asString((o.audiencePsychology as Record<string, unknown>)?.channelsEnemy, 'audiencePsychology.channelsEnemy'),
    },
    modelUsed: modelId,
    analyzedAt: new Date().toISOString(),
  };
}

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
function asContentFormat(v: unknown): ChannelCloneAnalysis['contentFormat'] {
  const allowed: ChannelCloneAnalysis['contentFormat'][] = ['essay', 'listicle', 'story', 'tutorial', 'hybrid'];
  if (typeof v !== 'string' || !(allowed as string[]).includes(v)) {
    throw new Error(`contentFormat must be one of ${allowed.join(', ')}`);
  }
  return v as ChannelCloneAnalysis['contentFormat'];
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone analyze] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'analyze_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
