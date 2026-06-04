import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import { competitorThumbnailPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';
import { resolveAndPinSafeUrl } from '@/lib/url-safety';

// Cap thumbnail buffer at 8 MB. Real YouTube thumbnails are well under
// 1 MB; anything larger is either an attack (slow-loris a server) or a
// misconfigured CDN that won't analyse cleanly anyway.
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export const maxDuration = 120;

/**
 * Analyze a single competitor video's thumbnail using vision.
 * Body: { modelId, videoRowId }
 * Returns: { analysis }
 *
 * Audit C2: previously unauthenticated. Now wrapped + workspace-scoped
 * via the parent competitor_channels row.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;

  const { limited } = checkRateLimit(`thumb-analyze:${getClientIP(req)}`, 10, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();
    // Workspace-scope check on the parent competitor.
    const owner = await sql`
      SELECT 1 FROM competitor_channels
       WHERE id = ${id}
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (owner.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
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
      'kie-gemini-2.5-flash', 'kie-gemini-2.5-pro', 'kie-gemini-3-flash', 'kie-gemini-3-pro', 'kie-gemini-3.1-pro', 'kie-gemini-3-5-flash',
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

    // Phase 8.6.1: SSRF + size cap on the stored thumbnail URL. The
    // URL was originally supplied by YouTube on sync, but a future
    // bulk-import or migration bug could let an attacker poison it
    // — so revalidate + DNS-pin on every fetch + bound the buffer.
    let imgRes: Response;
    try {
      const { url: safeUrl, dispatcher } = await resolveAndPinSafeUrl(
        v.thumbnail_url as string,
        { allowedProtocols: ['https:'] },
      );
      imgRes = await fetch(safeUrl, { dispatcher } as RequestInit & { dispatcher: unknown });
    } catch (err) {
      logger.warn('Thumbnail fetch rejected by SSRF guard', {
        competitor_id: id,
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Failed to fetch thumbnail' }, { status: 502 });
    }
    if (!imgRes.ok) return NextResponse.json({ error: 'Failed to fetch thumbnail' }, { status: 502 });
    const declaredLen = Number.parseInt(imgRes.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_THUMBNAIL_BYTES) {
      return NextResponse.json({ error: 'Thumbnail exceeds 8 MB cap' }, { status: 413 });
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const arrayBuf = await imgRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_THUMBNAIL_BYTES) {
      return NextResponse.json({ error: 'Thumbnail exceeds 8 MB cap' }, { status: 413 });
    }
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
    logger.error('Thumbnail analysis error', { detail: err instanceof Error ? err.message : String(err) });
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Thumbnail analysis failed: ${detail}` }, { status: 500 });
  }
});
