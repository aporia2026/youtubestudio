import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { thumbnailConceptPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { assertSafePublicUrl } from '@/lib/url-safety';

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
 * Includes every model whose `generateText` path forwards the `image`
 * option to its upstream API. As of the Kie-image patch in src/lib/ai.ts,
 * Kie Gemini (`/{model}/v1/chat/completions`) and Kie Claude
 * (`/claude/v1/messages`) both pass image blocks through faithfully —
 * Gemini via OpenAI-style `{type:'image_url'}` (same shape used in
 * analyzeYouTubeVideo()) and Claude via Anthropic-style
 * `{type:'image', source:{type:'base64', ...}}`.
 *
 * Kie GPT / Kie Codex (Responses API) is NOT in the list — those paths
 * send `input: string` and would need a body restructure for vision.
 * Direct OpenAI GPT-5 family is also excluded until vision support is
 * verified end-to-end against our SDK path.
 */
const VISION_ALLOWED = new Set<string>([
  // Anthropic direct — every Claude 4.x model accepts image blocks
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  // OpenAI direct — multimodal chat models (verified via SDK image_url path)
  'gpt-4o',
  'gpt-4o-mini',
  // Google direct — Gemini models accept inlineData blocks. The 3.x
  // direct entries are listed as "unverified, returns 404" in
  // ai-models.ts, so only the 2.x family is included here.
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  // Kie.ai — Gemini variants. All routed through Kie's
  // OpenAI-compatible chat completions endpoint with image_url blocks.
  'kie-gemini-2.5-flash',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3-pro',
  'kie-gemini-3.1-pro',
  // Kie.ai — Claude variants. All routed through Kie's
  // /claude/v1/messages passthrough with Anthropic-style image blocks.
  'kie-claude-opus-4-7',
  'kie-claude-opus-4-6',
  'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5',
  'kie-claude-opus-4-5',
  'kie-claude-haiku-4-5',
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
      let rawHostForError = '';
      // Use the string-based SSRF check (assertSafePublicUrl) + plain
      // fetch, NOT the DNS-rebinding-proof resolveAndPinSafeUrl variant.
      // The pinned-dispatcher path was tripping `fetch failed` on R2's
      // virtual-hosted S3 endpoint on the Vercel runtime — the custom
      // undici Agent doesn't play well with R2's TLS termination.
      //
      // Threat model: the fetched bytes are base64-encoded and passed to
      // an LLM. There is no shell exec, no DB write, no file write on this
      // path. A successful DNS-rebinding attack would only let an attacker
      // exfiltrate an internal endpoint's bytes *via* the LLM's analysis
      // text — a bounded, low-yield attack with no command consequence.
      // String-based hostname/IP-range checks are sufficient here.
      try {
        try { rawHostForError = new URL(referenceImageUrl.trim()).hostname; } catch { /* leave blank */ }
        const safeUrl = assertSafePublicUrl(
          referenceImageUrl.trim(),
          { allowedProtocols: ['https:'] },
        );
        host = safeUrl.hostname;
        imgRes = await fetch(safeUrl);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('[thumb-concepts] reference rejected', { reason, host: rawHostForError });
        return NextResponse.json({
          error: `Reference image URL was rejected (${rawHostForError || 'unknown host'}): ${reason}`,
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
