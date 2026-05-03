import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { youtubeDescriptionPrompt } from '@/lib/prompts';
import { getTemplate } from '@/lib/templates-db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';

export const maxDuration = 180;

// Strip residual AI tells the model might emit despite the prompt rules.
// Em-dashes are the most common — replace with comma + space (semantically
// closest in most contexts). Followed by en-dashes and a couple of stock
// phrases that slip through. Cheap belt-and-braces over the system prompt.
function postProcess(raw: string): string {
  let out = raw.trim();
  // Em-dash and en-dash → ", "
  out = out.replace(/\s*[—–]\s*/g, ', ');
  // Strip leading "Description:" / "Here's the description" preambles if any
  out = out.replace(/^\s*(here(?:'s| is)\s+(?:the\s+|your\s+)?description[:.]?\s*)/i, '');
  out = out.replace(/^\s*description[:]\s*/i, '');
  // Collapse 3+ newlines → 2
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`yt-desc:${getClientIP(req)}`, 15, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited, try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const body = await req.json();
    const { modelId, title, niche, topic, script, templateId, context } = body;

    if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
    if (!title || typeof title !== 'string') return NextResponse.json({ error: 'title is required' }, { status: 400 });
    if (!niche || typeof niche !== 'string') return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    if (!script || typeof script !== 'string' || script.trim().length < 100) {
      return NextResponse.json({ error: 'script must be at least 100 characters' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid modelId' }, { status: 400 });

    // If a template was picked, fetch its content. Combined with the
    // free-text context, this becomes the "creator's direction" block in
    // the prompt.
    let templateContent = '';
    if (templateId) {
      try {
        const t = await getTemplate(templateId);
        if (t && t.field_type === 'youtube_description') templateContent = t.content;
      } catch {}
    }
    const combinedParts: string[] = [];
    if (templateContent.trim()) combinedParts.push(`STYLE / DIRECTION (from saved template):\n${templateContent.trim()}`);
    if (typeof context === 'string' && context.trim()) combinedParts.push(`ADDITIONAL CONTEXT FOR THIS VIDEO:\n${context.trim()}`);
    const combinedContext = combinedParts.join('\n\n');

    const { system, user } = youtubeDescriptionPrompt({
      title,
      niche,
      topic: topic || undefined,
      script,
      combinedContext: combinedContext || undefined,
    });

    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      // Description sits comfortably under 1k tokens; cap generous to allow
      // multi-paragraph output but not so large that the model rambles.
      maxTokens: 1200,
      // Slightly higher temp than QA — we want voice variation, not cookie-cutter.
      temperature: 0.85,
      spend: await makeSpendContext('youtube_description', { metadata: { niche } }),
    });

    const description = postProcess(raw);
    return NextResponse.json({ description });
  } catch (err) {
    logger.error('youtube-description generate error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Generation failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
