import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { thumbnailConceptPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { resolveAndPinSafeUrl } from '@/lib/url-safety';

export const maxDuration = 300;

// Cap fetched reference image at 8 MB. Mirrors the cap used in
// `/api/competitors/[id]/thumbnail-analyze` — reference thumbnails are
// well under 1 MB in practice; anything larger is misconfigured or
// adversarial. Cap is enforced via both the declared content-length
// header AND the actual buffer byte length, since servers can lie.
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

/**
 * Vision-capable models for the concept generator.
 *
 * Restricted to the direct provider SDKs (`anthropic`, `openai`, `google`)
 * because that's where `generateText` actually forwards the `image` option
 * to the upstream API. The Kie provider branch in src/lib/ai.ts:544
 * currently drops images — its Claude + Gemini fetchers only send text
 * content blocks. Until that branch is extended, picking a `kie-*` model
 * for this route would silently produce text-only concepts. See
 * _plans/2026-05-18-thumbnail-reference-multimodal.md for the trade-off.
 *
 * GPT-5 family is intentionally excluded — vision support for the
 * gpt-5 / gpt-5-mini / gpt-5-nano variants over chat.completions has
 * not been verified against our SDK path. Add explicitly once confirmed.
 */
const VISION_ALLOWED = new Set<string>([
  // Anthropic — every Claude 4.x model accepts image blocks
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  // OpenAI — multimodal chat models (verified via SDK image_url path)
  'gpt-4o',
  'gpt-4o-mini',
  // Google — Gemini models accept inlineData blocks. The 3.x direct
  // entries are listed as "unverified, returns 404" in ai-models.ts,
  // so only the 2.x family is included here.
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
]);

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(`thumb:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
    }

    const { modelId, title, niche, script, description, referenceImageUrl } = await req.json();

    if (!title || !niche) {
      return NextResponse.json({ error: 'title and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const hasReference = typeof referenceImageUrl === 'string' && referenceImageUrl.trim().length > 0;

    logger.info('[thumb-concepts] generate start', {
      modelId,
      niche,
      has_reference: hasReference,
    });

    // Fetch + base64 the reference image when the user provided one.
    // Pattern mirrors src/app/api/competitors/[id]/thumbnail-analyze: DNS-pin
    // via resolveAndPinSafeUrl to defeat rebinding, cap declared and actual
    // byte length, capture mime type from response headers.
    let referenceImage: { base64: string; mimeType: string } | undefined;
    if (hasReference) {
      if (!VISION_ALLOWED.has(modelId)) {
        logger.warn('[thumb-concepts] model not vision', { modelId });
        return NextResponse.json({
          error: `Model "${model.name}" cannot read the reference image. Switch your AI Model to a Claude 4.x, GPT-4o, or Gemini 2.x model and generate again.`,
        }, { status: 400 });
      }

      const fetchStart = Date.now();
      let imgRes: Response;
      let host = '';
      try {
        const { url: safeUrl, dispatcher } = await resolveAndPinSafeUrl(
          referenceImageUrl.trim(),
          { allowedProtocols: ['https:'] },
        );
        host = safeUrl.hostname;
        imgRes = await fetch(safeUrl, { dispatcher } as RequestInit & { dispatcher: unknown });
      } catch (err) {
        logger.warn('[thumb-concepts] reference rejected', {
          reason: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json({
          error: 'Reference image URL was rejected — must be a public HTTPS URL.',
        }, { status: 400 });
      }
      if (!imgRes.ok) {
        logger.warn('[thumb-concepts] reference rejected', { reason: `upstream ${imgRes.status}` });
        return NextResponse.json({
          error: `Failed to fetch reference image (HTTP ${imgRes.status}).`,
        }, { status: 502 });
      }
      const declaredLen = Number.parseInt(imgRes.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLen) && declaredLen > MAX_REFERENCE_BYTES) {
        logger.warn('[thumb-concepts] reference rejected', { reason: `declared size ${declaredLen} > cap` });
        return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
      }
      const arrayBuf = await imgRes.arrayBuffer();
      if (arrayBuf.byteLength > MAX_REFERENCE_BYTES) {
        logger.warn('[thumb-concepts] reference rejected', { reason: `actual size ${arrayBuf.byteLength} > cap` });
        return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
      }
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      // Anthropic only accepts jpeg/png/gif/webp; normalise anything else to jpeg
      // (the byte-stream is still the original image; we're only labelling the
      // media_type the SDK uses). PNG is left as-is since it's the next most
      // common upload format from our R2 presigned flow.
      const mimeType = contentType.includes('png') ? 'image/png'
        : contentType.includes('webp') ? 'image/webp'
        : contentType.includes('gif') ? 'image/gif'
        : 'image/jpeg';
      referenceImage = {
        base64: Buffer.from(arrayBuf).toString('base64'),
        mimeType,
      };
      logger.info('[thumb-concepts] reference fetch', {
        host,
        bytes: arrayBuf.byteLength,
        mime: mimeType,
        duration_ms: Date.now() - fetchStart,
      });
    }

    const { system, user } = thumbnailConceptPrompt({
      title,
      niche,
      script,
      description,
      hasReferenceImage: !!referenceImage,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 8000,
      temperature: 0.8,
      image: referenceImage,
      spend: await makeSpendContext('thumbnail_concepts', { metadata: { niche, has_reference: !!referenceImage } }),
    });

    let result;
    try {
      result = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse thumbnail response — try again' }, { status: 500 });
    }

    logger.info('[thumb-concepts] generate done', {
      concepts_count: Array.isArray((result as { concepts?: unknown[] })?.concepts)
        ? (result as { concepts: unknown[] }).concepts.length
        : 0,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json({ result });
  } catch (err: unknown) {
    logger.error('Thumbnail generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Thumbnail generation failed' },
      { status: 500 },
    );
  }
}
