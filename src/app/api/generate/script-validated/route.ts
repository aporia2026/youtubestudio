import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { scriptGenerationPrompt, scriptQAPrompt, scriptExpansionPrompt, SCRIPT_WPM } from '@/lib/prompts';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getSession } from '@/lib/session';
import { resolveBrandKitForRequest } from '@/lib/channel-brand-kit';
import { countWords } from '@/lib/utils';

/** Same dynamic cap as the streaming route — derive from the duration so
 *  long scripts don't get truncated at the legacy 8000-token default. */
function computeMaxTokens(durationMinutes: number): number {
  const targetWords = durationMinutes * SCRIPT_WPM;
  const tokensFromTarget = Math.round(targetWords * 3);
  return Math.max(8000, Math.min(16000, tokensFromTarget));
}

/**
 * Self-QA'd script generation. Generates a script, runs it through the
 * existing nuclear-QA prompt to get a 0–100 score, and regenerates with
 * targeted feedback if the score falls below the threshold (default 85).
 *
 * Workflow per attempt:
 *   1. Generate script (or regenerate with previous QA feedback)
 *   2. Run QA scorer
 *   3. If overall_score >= threshold → return script + score
 *   4. Else → feed critical_issues + rewrite_suggestions back into the
 *      next attempt's prompt and try again
 *
 * Capped at MAX_ATTEMPTS to bound cost. If we never hit the threshold,
 * return the BEST attempt with its score and a `passed: false` flag so
 * the client can warn the user (or auto-reject per their settings).
 *
 * Input:  { modelId, topic, niche, duration, tone, style, audience,
 *           context, referenceContext, threshold?, maxAttempts?,
 *           previousScripts? }
 * Output: { script, qa, attempts, passed }
 */

export const runtime = 'nodejs';
// Vercel Pro caps serverless functions at 300s. Each attempt is ~90–140s
// (script gen + optional expansion + QA scorer). We track elapsed time
// and return the best-so-far before Vercel kills us — see DEADLINE_MS
// below.
export const maxDuration = 300;

const DEFAULT_THRESHOLD = 85;
// Default 2 — at 90-140s per attempt, three is essentially guaranteed
// to exceed Vercel's 300s cap. Users who really want a third attempt
// can pass maxAttempts:3 explicitly and accept the timeout risk.
const DEFAULT_MAX_ATTEMPTS = 2;
// Stop starting NEW attempts once this much wall-clock has elapsed.
// vercel.json caps this route at 300s (Pro plan ceiling without Fluid
// Compute). 240s leaves a 60s headroom for the in-flight attempt's
// gen+expand+QA to finish before Vercel kills the function. Tuned
// conservatively because the alternative (a 504 with no script
// returned) is much worse than "we ran 1 attempt instead of 2 and
// returned what we had".
const DEADLINE_MS = 240_000;

interface CriticalIssue {
  severity?: string;
  location?: string;
  issue?: string;
  fix?: string;
}
interface RewriteSuggestion {
  original?: string;
  improved?: string;
  reason?: string;
}
interface QAResult {
  overall_score?: number;
  hook_strength?: number;
  retention?: number;
  content_quality?: number;
  audience_targeting?: number;
  cta?: number;
  seo?: number;
  pacing?: number;
  critical_issues?: CriticalIssue[];
  strengths?: string[];
  rewrite_suggestions?: RewriteSuggestion[];
}

export async function POST(req: NextRequest) {
  const { limited } = checkRateLimit(`script-validated:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

  let body: {
    modelId?: string;
    topic?: string;
    niche?: string;
    duration?: number;
    tone?: string;
    style?: string;
    audience?: string;
    context?: string;
    referenceContext?: string;
    threshold?: number;
    maxAttempts?: number;
    /** Previously-generated scripts (hooks/topics) to avoid repeating. */
    previousScripts?: string[];
    /** Pre-built series-continuity block (from lib/series.ts formatPriorPartsForPrompt). */
    seriesContext?: string;
    /** User-authored script constraints (skip hook / skip CTA / custom). */
    constraints?: {
      skipHook?: boolean;
      skipSubscribeCTA?: boolean;
      skipClickableLinks?: boolean;
      custom?: string[];
    };
    /** Optional override of the active channel — if absent, the user's
     *  pinned channel is used to resolve the brand kit. */
    channelId?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { modelId, topic, niche, duration, tone, style, audience, context, referenceContext, previousScripts = [], seriesContext, constraints, channelId } = body;
  if (!topic || !niche) return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
  if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
  const model = getModelById(modelId);
  if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

  const threshold = Math.max(0, Math.min(100, body.threshold ?? DEFAULT_THRESHOLD));
  const maxAttempts = Math.max(1, Math.min(5, body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));

  // Resolve the active channel's brand kit once — every attempt + every QA
  // pass uses the same kit, so we only need to fetch it once per request.
  const session = await getSession();
  const brandKit = session
    ? await resolveBrandKitForRequest(session, channelId)
    : null;

  // Build a prefix that warns the LLM about prior scripts to avoid
  // repeating exact hooks / openings / structure.
  const dedupNote = previousScripts.length > 0
    ? `\n\nPREVIOUSLY GENERATED SCRIPTS — DO NOT REPEAT THESE HOOKS, OPENINGS, OR ANGLES:\n${previousScripts.slice(0, 6).map((s, i) => `--- Prior #${i + 1} (first 400 chars) ---\n${s.slice(0, 400)}`).join('\n\n')}\nWrite a fundamentally different angle.`
    : '';

  // Series continuity block (client-budgeted). When present, it overrides the
  // dedup note — the next part SHOULD reference the prior parts.
  const seriesBlock = typeof seriesContext === 'string' && seriesContext.trim() ? `\n\n${seriesContext.trim()}` : '';

  const attempts: Array<{ script: string; qa: QAResult; score: number }> = [];
  let lastFeedback: string | undefined;
  const startedAt = Date.now();
  let deadlineReached = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Deadline guard — don't START a new attempt if we'd risk getting
    // killed by Vercel before it can finish. Returning the best-so-far
    // (with passed:false) is strictly better than a 504 with nothing.
    if (attempt > 1 && Date.now() - startedAt > DEADLINE_MS) {
      deadlineReached = true;
      break;
    }
    // 1) Generate the script. On retries, fold the previous attempt's
    // critical issues into the prompt so the model knows what to fix.
    const retryNote = lastFeedback
      ? `\n\nPRIOR ATTEMPT FAILED QA (scored below ${threshold}). The reviewer's critical notes:\n${lastFeedback}\n\nRewrite from scratch addressing every issue. Don't merely tweak the prior script — restructure as needed.`
      : '';
    const targetDurationMinutes = duration || 7;
    const targetSpokenWords = targetDurationMinutes * SCRIPT_WPM;
    const minSpokenWords = Math.round(targetSpokenWords * 0.92);
    const dynamicMaxTokens = computeMaxTokens(targetDurationMinutes);

    const { system: scriptSystem, user: scriptUser } = scriptGenerationPrompt({
      topic,
      niche,
      targetDurationMinutes,
      tone,
      style,
      targetAudience: audience,
      additionalContext: (context || '') + (seriesBlock || dedupNote) + retryNote,
      referenceContext,
      constraints,
      brandKit,
    });

    let script: string;
    try {
      script = await generateText({
        modelId,
        prompt: scriptUser,
        systemPrompt: scriptSystem,
        maxTokens: dynamicMaxTokens,
        // Slightly higher temperature on retries to escape the prior local minimum.
        temperature: 0.8 + (attempt - 1) * 0.05,
        spend: session?.ws ? { workspaceId: session.ws, featureArea: 'script_validated', metadata: { phase: 'generate', attempt } } : undefined,
      });
      script = script.trim();
    } catch (err) {
      return NextResponse.json({
        error: `Script generation failed on attempt ${attempt}: ${err instanceof Error ? err.message : err}`,
      }, { status: 502 });
    }

    if (!script || script.length < 200) {
      lastFeedback = 'Script came back empty or too short — generate a full draft.';
      continue;
    }

    // Length-undershoot expansion. Same logic the streaming route uses —
    // models routinely return scripts at 40-60% of the asked-for duration,
    // so we run a dedicated expansion pass before handing the draft to QA.
    // Best-effort: if the expansion fails or returns shorter content, we
    // keep the first pass and let QA proceed.
    const initialSpokenWords = countWords(script);
    if (initialSpokenWords < minSpokenWords) {
      try {
        const { system: expandSystem, user: expandUser } = scriptExpansionPrompt({
          draftScript: script,
          topic,
          niche,
          targetDurationMinutes,
          currentSpokenWords: initialSpokenWords,
          constraints,
        });
        const expanded = (await generateText({
          modelId,
          prompt: expandUser,
          systemPrompt: expandSystem,
          maxTokens: dynamicMaxTokens,
          temperature: 0.65,
          spend: session?.ws ? { workspaceId: session.ws, featureArea: 'script_validated', metadata: { phase: 'expansion', attempt } } : undefined,
        })).trim();
        const expandedSpokenWords = countWords(expanded);
        if (expanded.length > 200 && expandedSpokenWords > initialSpokenWords) {
          script = expanded;
        }
      } catch (expandErr) {
        console.warn(`[script-validated] expansion pass failed attempt ${attempt}:`, expandErr);
      }
    }

    // 2) QA the script. Pass the same constraints so the reviewer doesn't
    // penalize intentionally-omitted elements (hook, CTA, links).
    const { system: qaSystem, user: qaUser } = scriptQAPrompt({
      script,
      niche,
      passNumber: attempt,
      previousFeedback: lastFeedback,
      aggressiveness: 'brutal',
      constraints,
      brandKit,
    });

    let qa: QAResult = {};
    let qaRaw = '';
    try {
      qaRaw = await generateText({
        modelId,
        prompt: qaUser,
        systemPrompt: qaSystem,
        maxTokens: 4000,
        temperature: 0.3,
        spend: session?.ws ? { workspaceId: session.ws, featureArea: 'script_validated', metadata: { phase: 'qa', attempt } } : undefined,
      });
      qa = parseLlmJson(qaRaw) as QAResult;
    } catch (err) {
      // QA failed to parse — accept the script with score=0 and mark failed
      // rather than blocking. Worst case: client falls back to manual QA.
      console.warn(`[script-validated] QA parse failed attempt ${attempt}:`, err);
      attempts.push({ script, qa: {}, score: 0 });
      lastFeedback = 'QA reviewer returned malformed output. Re-attempt.';
      continue;
    }

    const score = typeof qa.overall_score === 'number' ? qa.overall_score : 0;
    attempts.push({ script, qa, score });

    if (score >= threshold) {
      return NextResponse.json({
        script,
        qa,
        attempts: attempt,
        passed: true,
        threshold,
      });
    }

    // 3) Build feedback for the next attempt.
    const issues = (qa.critical_issues ?? []).slice(0, 8).map(i =>
      `- [${i.severity || 'issue'}] ${i.location ? `${i.location}: ` : ''}${i.issue || ''}${i.fix ? ` — fix: ${i.fix}` : ''}`,
    ).join('\n');
    const fixes = (qa.rewrite_suggestions ?? []).slice(0, 8).map(s =>
      `- "${s.original || ''}" → "${s.improved || ''}"${s.reason ? ` (${s.reason})` : ''}`,
    ).join('\n');
    lastFeedback = `Score: ${score}/100 (threshold: ${threshold}).\nCRITICAL ISSUES:\n${issues || '(none cited)'}\n\nSUGGESTED FIXES:\n${fixes || '(none cited)'}`;
  }

  // No attempt cleared the threshold — return the best one with passed:false
  // so the client can show a warning + allow manual override.
  const best = attempts.sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return NextResponse.json({ error: 'All generation attempts failed' }, { status: 500 });
  }
  return NextResponse.json({
    script: best.script,
    qa: best.qa,
    attempts: attempts.length,
    passed: false,
    threshold,
    bestScore: best.score,
    deadlineReached,
  });
}
