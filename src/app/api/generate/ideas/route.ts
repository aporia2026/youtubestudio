import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { ideaGenerationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson, salvageTruncatedJsonArray } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';

export const maxDuration = 300;

// Normalize a title for cross-attempt dedup: lowercase, collapse whitespace,
// strip leading/trailing punctuation. Matches "5 Ways to Get Rich!" with
// "5 ways to get rich" — close enough that visually-identical clones with
// different punctuation/casing both get filtered.
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/^[\s\W_]+|[\s\W_]+$/g, '').trim();
}

/**
 * Audit C3: previously the only gate was per-IP rate limiting — anonymous
 * callers could burn unlimited AI tokens (the rate limit is per IP, easily
 * spread across a botnet). Now apiRoute.authed gates on session, so spend
 * is attributable and unauthenticated traffic gets 401.
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  try {
    const { limited, resetIn } = checkRateLimit(`ideas:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const {
      modelId,
      niche,
      nicheDescription,
      nicheKeywords,
      extraContext,
      count,
      audience,
      focus,
      videoType,
      referenceContext,
      redditContext,
      existingTitles,
    } = await req.json();

    if (!niche) {
      return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const targetCount = Math.min(count || 10, 25);
    const exclusionSet = new Set<string>(
      (Array.isArray(existingTitles) ? existingTitles : []).map((t: string) => normalizeTitle(t)),
    );
    const hasAttribution = !!(referenceContext || redditContext);

    // Two-pass generation: ask the LLM, post-filter against exclusion set,
    // and if too many came back as duplicates, regenerate ONCE with the
    // freshly-collected dupes added to the exclusion list and stronger
    // emphasis on uniqueness. Caps at 2 LLM calls so we don't burn cost.
    const collected: Record<string, unknown>[] = [];
    let attempt = 0;
    while (collected.length < targetCount && attempt < 2) {
      attempt++;
      // Each attempt sees the union of original exclusions + anything we
      // already accepted in earlier attempts.
      const liveExcl = [
        ...exclusionSet,
        ...collected.map(i => normalizeTitle((i as { title?: string }).title || '')),
      ].filter(Boolean);
      const { system, user } = ideaGenerationPrompt({
        niche,
        nicheDescription: typeof nicheDescription === 'string' ? nicheDescription : undefined,
        nicheKeywords: Array.isArray(nicheKeywords) ? nicheKeywords : undefined,
        extraContext: typeof extraContext === 'string' ? extraContext : undefined,
        count: targetCount - collected.length + 3, // ask for a few extra so dedupe doesn't leave us short
        audience,
        focus,
        videoType,
        referenceContext,
        redditContext,
        existingTitles: liveExcl,
      });
      // The schema in ideaGenerationPrompt is large (~16 fields per idea
      // including a 7-field performance_breakdown sub-object). At 13 ideas
      // (count+3) realistic emit is 600-1000 tokens each, so the old 6000
      // no-attribution cap was truncating mid-array — every model produced
      // incomplete JSON. GPT-5 family on chat.completions also counts
      // reasoning tokens toward this budget, which made the old cap
      // effectively smaller. Match the attribution path at 12000.
      const maxTokens = 12000;
      logger.info('[ideas generate] llm call', {
        modelId,
        attempt,
        maxTokens,
        targetCount,
        askedFromModel: targetCount - collected.length + 3,
        collectedSoFar: collected.length,
        hasAttribution,
        focus,
        videoType,
      });
      const raw = await generateText({
        modelId,
        prompt: user,
        systemPrompt: system,
        maxTokens,
        // Bump temperature on the retry to escape the same neighbourhood.
        temperature: attempt === 1 ? 0.9 : 1.05,
        spend: await makeSpendContext('idea_generation', { metadata: { attempt, focus } }),
      });
      let parsed: { ideas?: unknown[] };
      try {
        parsed = parseLlmJson(raw) as { ideas?: unknown[] };
      } catch (parseErr) {
        // Truncation salvage: if the model hit its output cap mid-JSON,
        // we still have a prefix of complete idea objects inside the
        // `"ideas": [...]` array. Pull them out so a partial response
        // beats a hard failure. The maxTokens bump above should make
        // this rare, but chatty models on huge schemas still trip it.
        const salvaged = salvageTruncatedJsonArray(raw);
        if (salvaged && salvaged.length > 0) {
          logger.warn('[ideas generate] salvaged truncated JSON', {
            modelId,
            attempt,
            maxTokens,
            requestedCount: targetCount,
            salvagedCount: salvaged.length,
            rawLength: raw.length,
            parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
          parsed = { ideas: salvaged };
        } else {
          logger.error('[ideas generate] failed to parse model JSON', {
            modelId,
            attempt,
            maxTokens,
            requestedCount: targetCount,
            rawLength: raw.length,
            rawTail: raw.slice(-200),
            parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
            hasAttribution,
          });
          if (attempt === 1) continue; // try again
          return NextResponse.json({ error: 'Failed to parse ideas response — try again' }, { status: 500 });
        }
      }
      const fresh = (parsed.ideas ?? []) as Record<string, unknown>[];
      for (const idea of fresh) {
        const t = (idea as { title?: string }).title;
        if (typeof t !== 'string' || !t.trim()) continue;
        const norm = normalizeTitle(t);
        if (exclusionSet.has(norm)) continue;
        if (collected.some(c => normalizeTitle((c as { title?: string }).title || '') === norm)) continue;
        collected.push(idea);
        if (collected.length >= targetCount) break;
      }
    }

    logger.info('[ideas generate] returning', {
      modelId,
      requestedCount: targetCount,
      returnedCount: collected.length,
      attempts: attempt,
      shortfall: targetCount - collected.length,
      hasAttribution,
    });
    return NextResponse.json({ ideas: collected, requested: targetCount, returned: collected.length, attempts: attempt });
  } catch (err: unknown) {
    logger.error('Ideas generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
});
