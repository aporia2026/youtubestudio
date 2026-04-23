import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

export const maxDuration = 45;

/** POST /api/schedule/ai/title-from-script
 *  body: { item_id: string, modelId?: string }
 *  Generates 5 candidate titles from the item's linked script (uses the pinned
 *  script_id or the latest active one). */
export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`title-gen:${getClientIP(req)}`, 15, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    await ensureScheduleSchema();
    const { item_id, modelId } = await req.json() as { item_id: string; modelId?: string };
    if (!item_id) return NextResponse.json({ error: 'item_id required' }, { status: 400 });

    const item = await sql`SELECT title, project_id, script_id FROM schedule_items WHERE id = ${item_id}`;
    if (!item.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { project_id, script_id, title } = item.rows[0] as { project_id: string | null; script_id: string | null; title: string };

    if (!project_id) {
      return NextResponse.json({ error: 'No script yet — add one first' }, { status: 400 });
    }

    // Prefer the pinned script; fall back to the active version.
    const script = script_id
      ? await sql`SELECT content FROM scripts WHERE id = ${script_id}`
      : await sql`SELECT content FROM scripts WHERE project_id = ${project_id} AND is_active = true LIMIT 1`;
    const content = script.rows[0]?.content as string | undefined;
    if (!content) return NextResponse.json({ error: 'No script content found' }, { status: 400 });

    // Use only the first ~2000 chars — hook + opening arc dominate title relevance.
    const snippet = content.slice(0, 2500);

    const chosenModel = modelId || getFeatureDefaultModelId('seo');
    const system = `You are a YouTube title strategist. Generate exactly 5 title candidates for the given script.
Rules:
- 55-70 chars each. Title case.
- Curiosity gap without clickbait lies.
- Avoid repeating the working title verbatim.
- Mix angles: question, list, contrarian, promise, specific-number.
Return STRICT JSON: {"titles":[{"title":string,"angle":string,"ctr_hint":string}]}.`;

    const prompt = `WORKING TITLE: ${title || '(none)'}

SCRIPT (excerpt):
${snippet}

Generate 5 title candidates. JSON only.`;

    const raw = await generateText({
      modelId: chosenModel,
      prompt,
      systemPrompt: system,
      maxTokens: 900,
      temperature: 0.8,
    });

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: 'AI did not return JSON', raw }, { status: 502 });
    let parsed: unknown;
    try { parsed = JSON.parse(m[0]); }
    catch { return NextResponse.json({ error: 'Invalid JSON from AI' }, { status: 502 }); }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
