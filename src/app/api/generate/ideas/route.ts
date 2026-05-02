import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { ideaGenerationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 300;

// Normalize a title for cross-attempt dedup: lowercase, collapse whitespace,
// strip leading/trailing punctuation. Matches "5 Ways to Get Rich!" with
// "5 ways to get rich" — close enough that visually-identical clones with
// different punctuation/casing both get filtered.
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/^[\s\W_]+|[\s\W_]+$/g, '').trim();
}

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`ideas:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { modelId, niche, count, audience, focus, videoType, referenceContext, redditContext, existingTitles } = await req.json();

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
        count: targetCount - collected.length + 3, // ask for a few extra so dedupe doesn't leave us short
        audience,
        focus,
        videoType,
        referenceContext,
        redditContext,
        existingTitles: liveExcl,
      });
      const raw = await generateText({
        modelId,
        prompt: user,
        systemPrompt: system,
        maxTokens: hasAttribution ? 12000 : 6000,
        // Bump temperature on the retry to escape the same neighbourhood.
        temperature: attempt === 1 ? 0.9 : 1.05,
      });
      let parsed: { ideas?: unknown[] };
      try {
        parsed = parseLlmJson(raw) as { ideas?: unknown[] };
      } catch {
        if (attempt === 1) continue; // try again
        return NextResponse.json({ error: 'Failed to parse ideas response — try again' }, { status: 500 });
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

    return NextResponse.json({ ideas: collected, requested: targetCount, returned: collected.length, attempts: attempt });
  } catch (err: unknown) {
    console.error('Ideas generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}
