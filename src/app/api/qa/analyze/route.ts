import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { scriptQAPrompt } from '@/lib/prompts';
import { sql } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getTemplate } from '@/lib/templates-db';

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

    const { modelId, script, niche, aggressiveness, passNumber, previousFeedback, scriptId, projectId, constraints, templateId, context } = await req.json();

    if (!script || script.length < 50) {
      return NextResponse.json({ error: 'Script too short (min 50 chars)' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    // Merge a saved QA template (if picked) with the per-call context box
    // into a single reviewer-direction block. Mirrors the same pattern the
    // script generator and YouTube description routes use.
    let templateContent = '';
    if (templateId) {
      try {
        const t = await getTemplate(templateId);
        if (t && t.field_type === 'qa') templateContent = t.content;
      } catch {}
    }
    const ctxParts: string[] = [];
    if (templateContent.trim()) ctxParts.push(`STYLE / DIRECTION (from saved template):\n${templateContent.trim()}`);
    if (typeof context === 'string' && context.trim()) ctxParts.push(`ADDITIONAL CONTEXT FOR THIS PASS:\n${context.trim()}`);
    const additionalContext = ctxParts.join('\n\n');

    const { system, user } = scriptQAPrompt({
      script,
      niche: niche || 'General',
      passNumber: passNumber || 1,
      previousFeedback,
      aggressiveness: aggressiveness || 'brutal',
      constraints,
      additionalContext: additionalContext || undefined,
    });

    /**
     * Provider-call wrapper that handles two real failure modes:
     *   1. The provider throws (rate limit, expired key, etc) — surface verbatim.
     *   2. The provider returns 200 + empty body (some providers do this
     *      silently when `maxTokens` exceeds the model's per-completion
     *      cap, e.g. asking GPT-4 Turbo for 9000 tokens). We retry once
     *      with a conservative maxTokens before giving up.
     */
    async function callProvider(maxTokens: number): Promise<string> {
      return generateText({
        modelId,
        prompt: user,
        systemPrompt: system,
        maxTokens,
        temperature: 0.3,
      });
    }

    let raw = '';
    try {
      // Default 6000 — the value that's been stable in production. Bumping
      // it caused some providers (notably the GPT-4 Turbo family with a
      // 4096 hard cap on completions) to silently return empty.
      raw = await callProvider(6000);
      // Empty 200 — retry once at a conservative 4000.
      if (!raw || !raw.trim()) {
        console.warn('QA: provider returned empty at 6000 tokens, retrying at 4000');
        raw = await callProvider(4000);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'AI provider call failed';
      console.error('QA generateText failed:', e);
      return NextResponse.json({ error: `AI provider error: ${msg}` }, { status: 502 });
    }

    if (!raw || !raw.trim()) {
      return NextResponse.json(
        { error: 'Model returned an empty response after a retry. The provider likely failed silently — try a different model.' },
        { status: 502 },
      );
    }

    const result = extractJson(raw);
    if (!result || typeof result !== 'object') {
      // Include a snippet of the raw output so the user can see WHY parsing
      // failed (e.g. model wrote prose instead of JSON, or got cut off mid-
      // sentence). 200 chars is enough to spot the pattern without turning
      // the toast into a wall of text.
      const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
      console.error('QA JSON parse failed. Raw start:', snippet);
      return NextResponse.json(
        { error: `Model returned non-JSON output. Try a different model or re-run. Snippet: ${snippet || '(no content)'}` },
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
