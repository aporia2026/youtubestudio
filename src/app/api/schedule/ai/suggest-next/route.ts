import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

export const maxDuration = 60;

/** POST /api/schedule/ai/suggest-next
 *  body: { channel_id?: string, modelId?: string }
 *  Returns 3 candidate videos to schedule next, using saved ideas + current backlog + cadence signals. */
export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`schedule-suggest:${getClientIP(req)}`, 10, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    const { channel_id, modelId } = await req.json() as { channel_id?: string; modelId?: string };

    // Recent scheduled items for the channel (what's already planned)
    const recent = channel_id
      ? await sql`
          SELECT si.title, si.status, si.pillar, si.scheduled_for, si.tags
          FROM schedule_items si
          JOIN schedule_item_channels sic ON sic.item_id = si.id
          WHERE sic.channel_id = ${channel_id}
          ORDER BY si.scheduled_for DESC NULLS LAST, si.created_at DESC
          LIMIT 20
        `
      : await sql`
          SELECT title, status, pillar, scheduled_for, tags
          FROM schedule_items
          ORDER BY scheduled_for DESC NULLS LAST, created_at DESC
          LIMIT 20
        `;

    // Saved but unused idea library
    const ideas = await sql`
      SELECT title, hook, description, niche, tags
      FROM video_ideas
      WHERE is_saved = true
      ORDER BY created_at DESC
      LIMIT 40
    `;

    // Channel niche for context
    const channel = channel_id
      ? await sql`SELECT name, niche, description FROM channels WHERE id = ${channel_id}`
      : { rows: [] as Array<{ name: string; niche: string; description: string }> };
    const ch = channel.rows[0];

    const system = `You are a YouTube content strategist helping a solo creator decide their next video.
Return STRICT JSON: {"suggestions":[{"title":string,"reason":string,"source":"idea"|"new","matched_idea_title"?:string}]}.
Exactly 3 suggestions. "source":"idea" when the suggestion is pulled from the saved idea library; "matched_idea_title" must then copy the idea's exact title.
"source":"new" when you propose a fresh idea that fills a gap in the backlog. Each reason must be one sentence, referencing pillar balance, cadence gap, or viewer value.`;

    const backlog = recent.rows.map(r => ({ title: r.title, status: r.status, pillar: r.pillar, date: r.scheduled_for }));
    const savedIdeas = ideas.rows.map(r => ({ title: r.title, hook: r.hook, niche: r.niche }));

    const prompt = `CHANNEL:
${ch ? `- name: ${ch.name}\n- niche: ${ch.niche ?? 'unspecified'}\n- description: ${(ch.description ?? '').slice(0, 400)}` : '- (no specific channel — suggest cross-channel)'}

CURRENT BACKLOG (${backlog.length} items, newest first):
${backlog.map(b => `- [${b.status}] ${b.title}${b.pillar ? ` (pillar: ${b.pillar})` : ''}${b.date ? ` — ${new Date(b.date).toLocaleDateString()}` : ''}`).join('\n') || '(empty)'}

SAVED IDEA LIBRARY:
${savedIdeas.map(i => `- ${i.title}${i.hook ? ` — hook: ${i.hook}` : ''}`).join('\n') || '(empty)'}

Pick 3 strong next-video candidates. Prefer pulling from the saved idea library unless the backlog has an obvious gap (e.g. a pillar untouched for weeks) — in that case propose a new idea. Return JSON only, no prose.`;

    const chosenModel = modelId || getFeatureDefaultModelId('idea-generator');
    const raw = await generateText({
      modelId: chosenModel,
      prompt,
      systemPrompt: system,
      maxTokens: 1500,
      temperature: 0.6,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: 'AI did not return JSON', raw }, { status: 502 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return NextResponse.json({ error: 'Invalid JSON from AI', raw: jsonMatch[0] }, { status: 502 }); }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
