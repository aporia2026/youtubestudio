/**
 * Channel-clone script runner — V2.0 STATE 10 + STATE 11.
 *
 * Generates a full style-locked script, audits it against the 10-
 * point quality check, and runs the fix-and-rescore loop until
 * the audit's overall score clears the configured threshold or the
 * max-iterations cap fires. This is the single most load-bearing
 * mechanism in the V2.0 prompt; getting it right is the whole game.
 *
 * Loop shape:
 *   1. Generate the script (STATE 10) with the channel's style DNA
 *      and the chosen hook locked in.
 *   2. Audit the script (STATE 11) → 10 numeric scores.
 *   3. If the overall score >= threshold OR iterations >= max:
 *        accept and persist on `approvedScript`.
 *      Else:
 *        rewrite the weakest dimensions (single rewrite call,
 *        not a per-dimension fan-out — keeps cost predictable
 *        and gives the model the full picture in one shot)
 *        then loop back to step 2 with the revised script.
 *
 * Each iteration's audit lands on `auditHistory` so the user can
 * inspect the convergence path in the UI.
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

// ─── Output schemas ──────────────────────────────────────────────────

const SCRIPT_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "script": string,                  // full script from hook to outro, plain text (no markdown, no headings, no stage directions)
  "wordCount": number                // your honest word count of the script
}

Constraints:
- Script MUST start with the supplied hook verbatim.
- Length MUST be within ±5% of the target word count supplied below.
- 100% original — match style/rhythm/energy, never copy the channel's wording.
- No "Hook:" / "Body:" / "Outro:" headings. Continuous prose only.

Output ONLY the JSON object. First char \`{\`, last char \`}\`.`;

const AUDIT_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "overall": number,                 // overall 1-10 (average of the dimension scores, allowed one decimal)
  "breakdown": {
    "styleDnaMatch": number,         // 1-10
    "hookStrength": number,          // 1-10
    "pacingAccuracy": number,        // 1-10
    "emotionalFlowMatch": number,    // 1-10
    "retentionTechniques": number,   // 1-10
    "wordCountAccuracyPct": number,  // 0-100 (percent of target hit, 100 = within ±5%)
    "originality": number,           // 1-10
    "audiencePsychologyAlignment": number, // 1-10
    "ctaMatch": number,              // 1-10
    "productionReadiness": number    // 1-10
  },
  "verdict": string                  // 1-3 sentences explaining the score
}

Output ONLY the JSON object. First char \`{\`, last char \`}\`.`;

const REVISION_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "script": string,                  // the revised script, same plain-text rules as before
  "wordCount": number
}

Output ONLY the JSON object.`;

// ─── Types ───────────────────────────────────────────────────────────

export interface ChannelCloneAuditBreakdown {
  styleDnaMatch: number;
  hookStrength: number;
  pacingAccuracy: number;
  emotionalFlowMatch: number;
  retentionTechniques: number;
  wordCountAccuracyPct: number;
  originality: number;
  audiencePsychologyAlignment: number;
  ctaMatch: number;
  productionReadiness: number;
}

export interface ChannelCloneAuditIteration {
  iteration: number;
  scriptWordCount: number;
  overall: number;
  breakdown: ChannelCloneAuditBreakdown;
  verdict: string;
}

export interface RunScriptOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  /** 1-based hook index the user picked from the hooks list. */
  selectedHookIndex: number;
  /** Threshold for the audit's `overall` score. Default 90 → which
   *  means overall ≥ 9.0/10. Acceptable: 80 / 90 / 95 / 100. */
  threshold?: 80 | 90 | 95 | 100;
  /** How many audit→fix iterations to attempt. Default 3. */
  maxIterations?: 1 | 3 | 5;
}

// ─── Runner ──────────────────────────────────────────────────────────

export async function runScript(opts: RunScriptOptions): Promise<void> {
  const { jobId, workspaceId, selectedHookIndex } = opts;
  const threshold = opts.threshold ?? 90;
  const maxIterations = opts.maxIterations ?? 3;
  logger.info('[channel-clone script] start', { jobId, selectedHookIndex, threshold, maxIterations });
  await setChannelCloneJobStatus(jobId, workspaceId, 'script_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone script] job missing', { jobId });
    return;
  }
  const { analysis, topics, hooks, selectedTopicIndex } = job.state_jsonb;
  if (!analysis || !topics || !hooks || !selectedTopicIndex) {
    return failJob(jobId, workspaceId, 'Cannot generate script: analysis + topics + hooks must all be complete.');
  }
  if (selectedHookIndex < 1 || selectedHookIndex > hooks.length) {
    return failJob(jobId, workspaceId, `selectedHookIndex ${selectedHookIndex} is out of range (1-${hooks.length}).`);
  }
  const topic = topics[selectedTopicIndex - 1];
  const hook = hooks[selectedHookIndex - 1];
  const targetWordCount = analysis.avgVideoWordCount;

  const scriptModelId = await getEffectiveModelId(workspaceId, 'channel-clone-script-generation');
  const auditModelId = await getEffectiveModelId(workspaceId, 'channel-clone-script-audit');

  // ── Iteration 1: initial script ──────────────────────────────────
  let scriptText: string;
  let scriptWordCount: number;
  try {
    const initial = await generateInitialScript({
      workspaceId,
      jobId,
      projectId: opts.projectId ?? null,
      modelId: scriptModelId,
      analysis,
      topic,
      hook,
      targetWordCount,
    });
    scriptText = initial.script;
    scriptWordCount = initial.wordCount;
  } catch (err) {
    return failJob(jobId, workspaceId, `Initial script generation failed: ${errorMessage(err)}`);
  }

  // Persist the first draft immediately so the UI can show progress
  // before the audit loop completes.
  await mergeScriptDraft(jobId, workspaceId, {
    text: scriptText,
    wordCount: scriptWordCount,
    targetWordCount,
  });

  const auditHistory: ChannelCloneAuditIteration[] = [];
  let approved = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // ── Audit current draft ────────────────────────────────────────
    let audit: { overall: number; breakdown: ChannelCloneAuditBreakdown; verdict: string };
    try {
      audit = await auditScript({
        workspaceId,
        jobId,
        projectId: opts.projectId ?? null,
        modelId: auditModelId,
        analysis,
        topic,
        hook,
        targetWordCount,
        scriptText,
        scriptWordCount,
        iteration,
      });
    } catch (err) {
      // QA fix 2026-06-05: a transient audit error used to nuke the
      // whole job and discard the (potentially expensive) script the
      // user just spent Opus tokens generating. On iterations after
      // the first we still have a usable approved draft from the
      // previous audit; bail out of the loop and accept the current
      // draft instead of failing. On iteration 1 there's nothing to
      // accept yet, so the old fail-fast path stays.
      if (iteration > 1) {
        logger.warn('[channel-clone script] audit error after first iteration — accepting current draft', {
          jobId,
          iteration,
          error: errorMessage(err),
        });
        break;
      }
      return failJob(jobId, workspaceId, `Audit on iteration ${iteration} failed: ${errorMessage(err)}`);
    }

    const overallPct = audit.overall * 10; // 9.0/10 → 90
    auditHistory.push({
      iteration,
      scriptWordCount,
      overall: audit.overall,
      breakdown: audit.breakdown,
      verdict: audit.verdict,
    });
    await mergeAuditHistory(jobId, workspaceId, auditHistory);

    logger.info('[channel-clone script] audit', {
      jobId,
      iteration,
      overall: audit.overall,
      overallPct,
      threshold,
      wordCount: scriptWordCount,
      target: targetWordCount,
    });

    if (overallPct >= threshold) {
      approved = true;
      break;
    }
    if (iteration === maxIterations) {
      // Out of iterations — accept the current draft as the final.
      logger.warn('[channel-clone script] threshold not reached; accepting last draft', {
        jobId,
        iteration,
        overallPct,
        threshold,
      });
      break;
    }

    // ── Revise based on the audit's weakest dimensions ─────────────
    try {
      const revised = await reviseScript({
        workspaceId,
        jobId,
        projectId: opts.projectId ?? null,
        modelId: scriptModelId,
        analysis,
        topic,
        hook,
        targetWordCount,
        scriptText,
        audit,
        iteration,
      });
      scriptText = revised.script;
      scriptWordCount = revised.wordCount;
      await mergeScriptDraft(jobId, workspaceId, {
        text: scriptText,
        wordCount: scriptWordCount,
        targetWordCount,
      });
    } catch (err) {
      return failJob(jobId, workspaceId, `Revision on iteration ${iteration} failed: ${errorMessage(err)}`);
    }
  }

  const finalScore = auditHistory[auditHistory.length - 1]?.overall ?? 0;
  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    selectedHookIndex,
    scriptDraft: { text: scriptText, wordCount: scriptWordCount, targetWordCount },
    auditHistory,
    approvedScript: { text: scriptText, wordCount: scriptWordCount, finalScore },
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'script_complete');
  logger.info('[channel-clone script] done', {
    jobId,
    iterations: auditHistory.length,
    finalScore,
    approved,
    wordCount: scriptWordCount,
    target: targetWordCount,
  });
}

// ─── LLM call helpers ────────────────────────────────────────────────

interface ScriptCallArgs {
  workspaceId: string;
  jobId: string;
  projectId: string | null;
  modelId: string;
  analysis: NonNullable<ChannelCloneJobState['analysis']>;
  topic: NonNullable<ChannelCloneJobState['topics']>[number];
  hook: NonNullable<ChannelCloneJobState['hooks']>[number];
  targetWordCount: number;
}

async function generateInitialScript(args: ScriptCallArgs): Promise<{ script: string; wordCount: number }> {
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-script-generation') + '\n\n' + SCRIPT_OUTPUT_SCHEMA;
  const userPrompt = buildScriptUserPrompt(args);
  const raw = await generateText({
    modelId: args.modelId,
    systemPrompt,
    prompt: userPrompt,
    maxTokens: Math.max(4000, Math.ceil(args.targetWordCount * 2)),
    temperature: 0.85,
    spend: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      featureArea: 'channel_clone_script_initial',
      metadata: { jobId: args.jobId, target: args.targetWordCount },
    },
  });
  return parseScriptResponse(raw);
}

async function reviseScript(
  args: ScriptCallArgs & {
    scriptText: string;
    audit: { overall: number; breakdown: ChannelCloneAuditBreakdown; verdict: string };
    iteration: number;
  },
): Promise<{ script: string; wordCount: number }> {
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-script-generation') + '\n\n' + REVISION_OUTPUT_SCHEMA;
  const weak = describeWeakDimensions(args.audit.breakdown);
  const userPrompt = [
    `You are revising the script on iteration ${args.iteration + 1}.`,
    `Audit verdict: ${args.audit.verdict}`,
    `Weakest dimensions to fix: ${weak}.`,
    `Target word count: ${args.targetWordCount} (±5%).`,
    '',
    'Rewrite the script. Keep what worked (hook adherence, signature phrases) and fix the weak dimensions. Same plain-text rules as before.',
    '',
    'Current draft:',
    args.scriptText,
  ].join('\n');
  const raw = await generateText({
    modelId: args.modelId,
    systemPrompt,
    prompt: userPrompt,
    maxTokens: Math.max(4000, Math.ceil(args.targetWordCount * 2)),
    temperature: 0.8,
    spend: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      featureArea: 'channel_clone_script_revise',
      metadata: { jobId: args.jobId, iteration: args.iteration },
    },
  });
  return parseScriptResponse(raw);
}

async function auditScript(args: ScriptCallArgs & {
  scriptText: string;
  scriptWordCount: number;
  iteration: number;
}): Promise<{ overall: number; breakdown: ChannelCloneAuditBreakdown; verdict: string }> {
  const systemPrompt =
    getChannelCloneSystemPrompt('channel-clone-script-audit') + '\n\n' + AUDIT_OUTPUT_SCHEMA;
  const userPrompt = [
    `You are at STATE 11. Audit this script against the 10-point check.`,
    `Target word count: ${args.targetWordCount} (±5% = ${Math.round(args.targetWordCount * 0.05)} words).`,
    `Reported word count: ${args.scriptWordCount}.`,
    '',
    'Channel context:',
    `- WPS: ${args.analysis.wpsEstimate.toFixed(2)}`,
    `- Hook architecture: ${args.analysis.hookArchitecture}`,
    `- Style DNA tonal fingerprint: ${args.analysis.styleDna.tonalFingerprint}`,
    `- Audience identity promise: ${args.analysis.audiencePsychology.identityPromise}`,
    `- Audience pain points: ${args.analysis.audiencePsychology.painPoints.join(', ')}`,
    `- Signature phrases: ${args.analysis.signaturePhrases.join(' | ')}`,
    `- Selected topic: ${args.topic.title} (${args.topic.angle})`,
    `- Selected hook (${args.hook.archetype}): ${args.hook.text}`,
    '',
    'Score every dimension on its own merits. wordCountAccuracyPct = 100 when wordCount is within ±5% of target, scaled linearly down to 50 at ±20%, and 0 at ±40%+.',
    '',
    'Script:',
    args.scriptText,
  ].join('\n');
  const raw = await generateText({
    modelId: args.modelId,
    systemPrompt,
    prompt: userPrompt,
    maxTokens: 2000,
    temperature: 0.2,
    spend: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      featureArea: 'channel_clone_script_audit',
      metadata: { jobId: args.jobId, iteration: args.iteration },
    },
  });
  return parseAuditResponse(raw);
}

function buildScriptUserPrompt(args: ScriptCallArgs): string {
  return [
    'You are at STATE 10. Generate the full script.',
    '',
    `Target word count: ${args.targetWordCount} (±5%).`,
    `Target duration: ${(args.targetWordCount / args.analysis.wpsEstimate / 60).toFixed(1)} min at the channel's WPS.`,
    `Channel WPS: ${args.analysis.wpsEstimate.toFixed(2)}`,
    `Selected hook archetype: ${args.hook.archetype}`,
    `Selected hook text (start the script with this verbatim): ${args.hook.text}`,
    '',
    'Selected topic:',
    `- Title: ${args.topic.title}`,
    `- Angle: ${args.topic.angle}`,
    '',
    'Style DNA to lock in:',
    `- Sentence rhythm: ${args.analysis.styleDna.sentenceRhythm}`,
    `- Tonal fingerprint: ${args.analysis.styleDna.tonalFingerprint}`,
    `- Transition mechanics: ${args.analysis.styleDna.transitionMechanics}`,
    `- Metaphor patterns: ${args.analysis.styleDna.metaphorPatterns}`,
    `- Opening patterns: ${args.analysis.styleDna.openingPatterns}`,
    `- Closing patterns: ${args.analysis.styleDna.closingPatterns}`,
    '',
    'Audience psychology:',
    `- Pain points to address: ${args.analysis.audiencePsychology.painPoints.join(', ')}`,
    `- Identity promise: ${args.analysis.audiencePsychology.identityPromise}`,
    `- Channel's enemy (positioning): ${args.analysis.audiencePsychology.channelsEnemy}`,
    '',
    `Reuse these signature phrases or close variants where they fit the rhythm: ${args.analysis.signaturePhrases.join(' | ')}`,
    '',
    'Write the full script now.',
  ].join('\n');
}

function describeWeakDimensions(b: ChannelCloneAuditBreakdown): string {
  const pairs: { name: string; score: number }[] = [
    { name: 'Style DNA match', score: b.styleDnaMatch },
    { name: 'Hook strength', score: b.hookStrength },
    { name: 'Pacing accuracy', score: b.pacingAccuracy },
    { name: 'Emotional flow', score: b.emotionalFlowMatch },
    { name: 'Retention techniques', score: b.retentionTechniques },
    { name: 'Word count accuracy', score: b.wordCountAccuracyPct / 10 },
    { name: 'Originality', score: b.originality },
    { name: 'Audience psychology alignment', score: b.audiencePsychologyAlignment },
    { name: 'CTA match', score: b.ctaMatch },
    { name: 'Production readiness', score: b.productionReadiness },
  ];
  pairs.sort((a, b) => a.score - b.score);
  return pairs.slice(0, 3).map((p) => `${p.name} (${p.score.toFixed(1)}/10)`).join(', ');
}

// ─── Parsers (exported for tests) ────────────────────────────────────

export function parseScriptResponse(raw: string): { script: string; wordCount: number } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const obj = JSON.parse(cleaned) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;
  if (typeof o.script !== 'string' || o.script.length < 100) throw new Error('script must be a non-trivial string');
  if (typeof o.wordCount !== 'number' || !Number.isFinite(o.wordCount) || o.wordCount < 50) {
    throw new Error('wordCount must be a positive number ≥50');
  }
  return { script: o.script, wordCount: o.wordCount };
}

export function parseAuditResponse(raw: string): { overall: number; breakdown: ChannelCloneAuditBreakdown; verdict: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const obj = JSON.parse(cleaned) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;
  if (typeof o.overall !== 'number' || o.overall < 0 || o.overall > 10) {
    throw new Error('overall must be a number 0-10');
  }
  if (typeof o.verdict !== 'string' || o.verdict.length === 0) {
    throw new Error('verdict must be a non-empty string');
  }
  const b = o.breakdown as Record<string, unknown> | undefined;
  if (!b) throw new Error('breakdown is required');
  const breakdown: ChannelCloneAuditBreakdown = {
    styleDnaMatch: scoreNum(b.styleDnaMatch, 'breakdown.styleDnaMatch'),
    hookStrength: scoreNum(b.hookStrength, 'breakdown.hookStrength'),
    pacingAccuracy: scoreNum(b.pacingAccuracy, 'breakdown.pacingAccuracy'),
    emotionalFlowMatch: scoreNum(b.emotionalFlowMatch, 'breakdown.emotionalFlowMatch'),
    retentionTechniques: scoreNum(b.retentionTechniques, 'breakdown.retentionTechniques'),
    wordCountAccuracyPct: pctNum(b.wordCountAccuracyPct, 'breakdown.wordCountAccuracyPct'),
    originality: scoreNum(b.originality, 'breakdown.originality'),
    audiencePsychologyAlignment: scoreNum(b.audiencePsychologyAlignment, 'breakdown.audiencePsychologyAlignment'),
    ctaMatch: scoreNum(b.ctaMatch, 'breakdown.ctaMatch'),
    productionReadiness: scoreNum(b.productionReadiness, 'breakdown.productionReadiness'),
  };
  return { overall: o.overall, breakdown, verdict: o.verdict };
}

function scoreNum(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10) {
    throw new Error(`${key} must be a number 0-10`);
  }
  return v;
}
function pctNum(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`${key} must be a number 0-100`);
  }
  return v;
}

// ─── Persistence helpers ─────────────────────────────────────────────

async function mergeScriptDraft(
  jobId: string,
  workspaceId: string,
  scriptDraft: NonNullable<ChannelCloneJobState['scriptDraft']>,
): Promise<void> {
  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  await replaceChannelCloneJobState(jobId, workspaceId, { ...fresh.state_jsonb, scriptDraft });
}

async function mergeAuditHistory(
  jobId: string,
  workspaceId: string,
  auditHistory: ChannelCloneAuditIteration[],
): Promise<void> {
  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  await replaceChannelCloneJobState(jobId, workspaceId, { ...fresh.state_jsonb, auditHistory });
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone script] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'script_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
