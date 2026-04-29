import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { scriptQAPrompt } from '@/lib/prompts';
import { sql } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 300;

/**
 * Best-effort JSON extraction from a model response. Models occasionally:
 *   - return raw JSON
 *   - wrap JSON in ```json fences
 *   - prepend "Here's the analysis:" prose before the JSON
 *   - emit two JSON blocks (one for thinking, one for the answer)
 *   - close with stray prose ("Hope this helps!")
 *
 * Try fences first (most reliable), then the largest balanced { ... } block,
 * then a naive last-resort regex. Return null when nothing parses.
 */
function extractJson(raw: string): unknown | null {
  // 1. Look for ```json … ``` fence (or just ``` … ``` if it parses)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // 2. Find the largest balanced object by walking characters and tracking
  // depth. This handles "prose { JSON } more prose" reliably without a
  // greedy regex that grabs trailing junk.
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }

  // 3. Last resort — naive greedy match.
  const greedy = raw.match(/\{[\s\S]*\}/);
  if (greedy) {
    try { return JSON.parse(greedy[0]); } catch {}
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`qa:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { modelId, script, niche, aggressiveness, passNumber, previousFeedback, scriptId, projectId, constraints } = await req.json();

    if (!script || script.length < 50) {
      return NextResponse.json({ error: 'Script too short (min 50 chars)' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = scriptQAPrompt({
      script,
      niche: niche || 'General',
      passNumber: passNumber || 1,
      previousFeedback,
      aggressiveness: aggressiveness || 'brutal',
      constraints,
    });

    let raw: string;
    try {
      raw = await generateText({
        modelId,
        prompt: user,
        systemPrompt: system,
        // Bumped 6000 → 9000. On pass 3+ with previousFeedback the prompt is
        // larger and verbose models (Opus, Sonnet) sometimes hit the cap and
        // truncate mid-JSON, which then fails extraction below.
        maxTokens: 9000,
        temperature: 0.3,
      });
    } catch (e) {
      // Surface the provider error verbatim — usually rate limit, expired
      // key, or model-doesn't-exist. Without this the catch below would
      // wrap it in "QA analysis failed" and we'd lose the signal.
      const msg = e instanceof Error ? e.message : 'AI provider call failed';
      console.error('QA generateText failed:', e);
      return NextResponse.json({ error: `AI provider error: ${msg}` }, { status: 502 });
    }

    const result = extractJson(raw);
    if (!result || typeof result !== 'object') {
      // Include a snippet of the raw output so the user can see WHY parsing
      // failed (e.g. model wrote prose instead of JSON, or got cut off mid-
      // sentence). 200 chars is enough to spot the pattern without turning
      // the toast into a wall of text.
      const snippet = (raw || '').slice(0, 200).replace(/\s+/g, ' ').trim();
      console.error('QA JSON parse failed. Raw start:', snippet);
      return NextResponse.json(
        { error: `Model returned non-JSON output. Try a different model or re-run. Snippet: ${snippet}` },
        { status: 502 },
      );
    }

    // Persist to DB if we have context
    try {
      if (projectId || scriptId) {
        await sql`
          INSERT INTO qa_sessions (script_id, project_id, pass_number, overall_score, feedback, issues, suggestions, ai_model)
          VALUES (
            ${scriptId || null},
            ${projectId || null},
            ${passNumber || 1},
            ${(result as { overall_score?: number }).overall_score ?? null},
            ${JSON.stringify((result as { categories?: unknown }).categories ?? {})},
            ${JSON.stringify((result as { critical_issues?: unknown[] }).critical_issues ?? [])},
            ${JSON.stringify((result as { rewrite_suggestions?: unknown[] }).rewrite_suggestions ?? [])},
            ${modelId}
          )
        `;
      }
    } catch (dbErr) {
      console.warn('DB save error (non-fatal):', dbErr);
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error('QA analyze error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'QA analysis failed' },
      { status: 500 }
    );
  }
}
