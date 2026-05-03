import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import { competitorThumbnailPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';

export const maxDuration = 120;

/**
 * Analyze a single competitor video's thumbnail using vision.
 * Body: { modelId, videoRowId }
 * Returns: { analysis }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`thumb-analyze:${getClientIP(req)}`, 10, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();
    let body: { modelId?: string; videoRowId?: string };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { modelId, videoRowId } = body;
    if (!modelId || !videoRowId) return NextResponse.json({ error: 'modelId and videoRowId required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    // Strict allowlist of vision-capable models. OpenAI o3 and Perplexity sonar do NOT
    // accept image inputs; Kie GPT models go through the responses API which we don't wire
    // up for images here.
    const VISION_ALLOWED = new Set([
      // Anthropic — all Claude models accept images
      'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
      // OpenAI — only multimodal chat models
      'gpt-4o', 'gpt-4o-mini',
      // Google — all Gemini accept images
      'gemini-2.0-flash', 'gemini-2.0-flash-thinking-exp',
      // Kie.ai — Gemini and Claude variants accept images via their respective SDKs
      'kie-gemini-2.5-flash', 'kie-gemini-2.5-pro', 'kie-gemini-3-flash', 'kie-gemini-3-pro', 'kie-gemini-3.1-pro',
      'kie-claude-opus-4-6', 'kie-claude-sonnet-4-6', 'kie-claude-sonnet-4-5', 'kie-claude-opus-4-5', 'kie-claude-haiku-4-5',
    ]);
    if (!VISION_ALLOWED.has(modelId)) {
      return NextResponse.json({
        error: `Model "${model.name}" does not support image input. Use a Claude (any), GPT-4o, GPT-4o Mini, Gemini, or a Kie.ai Claude/Gemini variant.`,
      }, { status: 400 });
    }

    const videoRes = await sql`
      SELECT id, title, view_count, outlier_score, thumbnail_url, thumbnail_analysis
      FROM competitor_videos
      WHERE id = ${videoRowId} AND competitor_id = ${id}
    `;
    if (videoRes.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    const v = videoRes.rows[0];
    if (!v.thumbnail_url) return NextResponse.json({ error: 'No thumbnail URL stored' }, { status: 400 });

    // Cache hit
    if (v.thumbnail_analysis) {
      return NextResponse.json({ analysis: v.thumbnail_analysis, cached: true });
    }

    // Download thumbnail
    const imgRes = await fetch(v.thumbnail_url as string);
    if (!imgRes.ok) return NextResponse.json({ error: 'Failed to fetch thumbnail' }, { status: 502 });
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const arrayBuf = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');

    const { system, user } = competitorThumbnailPrompt({
      videoTitle: String(v.title),
      views: Number(v.view_count) || 0,
      outlierScore: Number(v.outlier_score) || 0,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 3000,
      temperature: 0.2,
      image: { base64, mimeType: contentType.includes('png') ? 'image/png' : 'image/jpeg' },
      spend: await makeSpendContext('competitor_thumbnail_analysis', { metadata: { competitor_id: id } }),
    });

    let analysis;
    try { analysis = parseLlmJson(raw); } catch {
      return NextResponse.json({ error: 'Failed to parse analysis', raw: raw.slice(0, 500) }, { status: 500 });
    }

    await sql`
      UPDATE competitor_videos
      SET thumbnail_analysis = ${JSON.stringify(analysis)}::jsonb,
          thumbnail_analyzed_at = NOW()
      WHERE id = ${videoRowId}
    `;

    return NextResponse.json({ analysis, cached: false });
  } catch (err) {
    console.error('Thumbnail analysis error:', err);
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Thumbnail analysis failed: ${detail}` }, { status: 500 });
  }
}
