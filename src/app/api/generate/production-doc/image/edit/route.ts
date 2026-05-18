import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { computeImageSaliency } from '@/lib/image-saliency';
import {
  createGpt4oImageTask,
  createKieTask,
  pollGpt4oImageResult,
  pollKieResult,
} from '@/lib/kie-poll';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

/**
 * Edit an image on a production-doc row.
 *
 * Two tiers:
 *
 *   1. Smart edit (`model: 'nano-banana-edit'`): Gemini 2.5 Flash Image
 *      via Kie's `google/nano-banana-edit`. Prompt + source image only;
 *      the model uses semantic segmentation to find the region the prompt
 *      describes. Cheap (~$0.02 / call) and the default for users who
 *      just type "change the kid's shirt to red".
 *
 *   2. Mask edit (`model: 'gpt-4o-image-edit'`): GPT-4o image via Kie's
 *      `gpt4o-image/generate` with `filesUrl + maskUrl`. The mask is a
 *      black/white PNG of identical dimensions to the source: black
 *      pixels indicate regions to regenerate, white pixels are
 *      preserved. Used by the brush UI for precise region edits.
 *      Pricing tracks `quality`: low=$0.02, medium=$0.07, high=$0.19.
 *
 * Both branches mirror the result into R2 (so the URL is stable + CDN'd)
 * and compute a saliency map on the new image so the row's overlay
 * placement updates against the edited content.
 *
 * Authed. Rate-limited at 20/min/IP — edits are more expensive than
 * generations and roughly proportional in latency.
 */

const ALLOWED_EDIT_MODELS = ['nano-banana-edit', 'gpt-4o-image-edit'] as const;
type EditModel = (typeof ALLOWED_EDIT_MODELS)[number];

interface EditRequestBody {
  originalImageUrl?: string;
  prompt?: string;
  model?: string;
  mask?: { url?: string; quality?: 'low' | 'medium' | 'high' };
}

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  const { limited } = checkRateLimit(`prodoc-img-edit:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: EditRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { originalImageUrl, prompt } = body;
  const model = (body.model || 'nano-banana-edit') as EditModel;
  if (!ALLOWED_EDIT_MODELS.includes(model)) {
    return NextResponse.json(
      { error: `Unknown edit model: ${model}. Valid: ${ALLOWED_EDIT_MODELS.join(', ')}` },
      { status: 400 },
    );
  }
  if (!originalImageUrl?.trim() || !prompt?.trim()) {
    return NextResponse.json({ error: 'originalImageUrl + prompt required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ error: 'Prompt too long (max 2000 chars)' }, { status: 400 });
  }

  // SSRF guard. Both URLs become inputs to Kie.ai — but we also want to
  // reject anything pointing at our private network, in case a row's
  // `imageUrl` was clobbered by a future bug. Kie's fetch happens
  // server-to-server from their infra so the IP risk is theirs, but
  // we still reject before the round-trip so it fails fast and doesn't
  // bill us for a doomed task.
  const sourceCheck = checkSafePublicUrl(originalImageUrl, { allowedProtocols: ['https:'] });
  if (!sourceCheck.ok) {
    return NextResponse.json({ error: `Source image: ${sourceCheck.error}` }, { status: 400 });
  }

  let maskUrl: string | undefined;
  let maskQuality: 'low' | 'medium' | 'high' = 'medium';
  if (model === 'gpt-4o-image-edit') {
    if (!body.mask?.url) {
      return NextResponse.json({ error: 'mask.url required for gpt-4o-image-edit' }, { status: 400 });
    }
    const maskCheck = checkSafePublicUrl(body.mask.url, { allowedProtocols: ['https:'] });
    if (!maskCheck.ok) {
      return NextResponse.json({ error: `Mask URL: ${maskCheck.error}` }, { status: 400 });
    }
    maskUrl = body.mask.url;
    if (body.mask.quality === 'low' || body.mask.quality === 'medium' || body.mask.quality === 'high') {
      maskQuality = body.mask.quality;
    }
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
  }

  try {
    let resultUrl: string;
    if (model === 'nano-banana-edit') {
      const taskId = await createKieTask(apiKey, 'google/nano-banana-edit', {
        prompt: prompt.trim(),
        image_urls: [originalImageUrl],
        image_size: '16:9',
        output_format: 'png',
      });
      resultUrl = await pollKieResult(taskId, apiKey);
    } else {
      // GPT-4o image edit. The endpoint only accepts 1:1 / 3:2 / 2:3
      // — 3:2 is the closest match to the 16:9 production-doc target,
      // and the renderer crops to 16:9 at compose time anyway.
      const taskId = await createGpt4oImageTask(apiKey, {
        prompt: prompt.trim(),
        filesUrl: [originalImageUrl],
        maskUrl,
        size: '3:2',
        quality: maskQuality,
      });
      resultUrl = await pollGpt4oImageResult(taskId, apiKey);
    }

    // Mirror to R2 + compute saliency. Both fail-soft: a mirror failure
    // falls back to Kie's CDN URL (still usable until upstream retention
    // expires), and a saliency failure leaves the row's overlay
    // resolution unchanged.
    let imageUrl = resultUrl;
    let imageBuffer: Buffer | null = null;
    try {
      const imgRes = await fetch(resultUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        imageBuffer = buffer;
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-edit-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      }
    } catch (uploadErr) {
      logger.warn('[image-edit] R2 mirror failed, falling back to Kie URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }

    const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
    return NextResponse.json({ imageUrl, saliency });
  } catch (err) {
    logger.error('Production-doc image edit failed', {
      detail: err instanceof Error ? err.message : String(err),
      model,
      promptLength: prompt.length,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Edit failed' },
      { status: 500 },
    );
  }
});
