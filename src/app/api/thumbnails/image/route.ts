import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { domainErrorResponse } from '@/lib/route-helpers';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { generateImageOpenAI } from '@/lib/openai-images';
import { uploadToBucket, getImagesBucket, getImagesDownloadUrl } from '@/lib/r2';

export const maxDuration = 300;

/**
 * Image generation model configurations.
 *
 * Two provider lanes:
 *  - `kie`: async task on Kie.ai (createKieTask + pollKieResult). The
 *    reference image flows as a URL when image-to-image.
 *  - `openai`: sync OpenAI direct call to /v1/images/edits (i2i) or
 *    /v1/images/generations (t2i). Reference flows as raw bytes via
 *    multipart upload; resulting PNG is mirrored to R2 for a permanent
 *    URL so the response shape matches the Kie path.
 *
 * GPT Image 2 on Kie uses `input_urls` for i2i; everything else on Kie
 * uses `image_urls`. The provider tag below selects the code path.
 */
type ModelConfig =
  | { provider: 'kie'; model: string; type: 'text-to-image' | 'image-to-image' }
  | { provider: 'openai'; type: 'text-to-image' | 'image-to-image' };

const MODEL_MAP: Record<string, ModelConfig> = {
  'grok-imagine-t2i': { provider: 'kie', model: 'grok-imagine/text-to-image', type: 'text-to-image' },
  'flux2-pro-t2i': { provider: 'kie', model: 'flux-2/pro-text-to-image', type: 'text-to-image' },
  'flux2-flex-t2i': { provider: 'kie', model: 'flux-2/flex-text-to-image', type: 'text-to-image' },
  'nano-banana': { provider: 'kie', model: 'google/nano-banana', type: 'text-to-image' },
  'gpt-image-2-t2i': { provider: 'kie', model: 'gpt-image-2-text-to-image', type: 'text-to-image' },
  'grok-imagine-i2i': { provider: 'kie', model: 'grok-imagine/image-to-image', type: 'image-to-image' },
  'flux2-pro-i2i': { provider: 'kie', model: 'flux-2/pro-image-to-image', type: 'image-to-image' },
  'flux2-flex-i2i': { provider: 'kie', model: 'flux-2/flex-image-to-image', type: 'image-to-image' },
  'gpt-image-2-i2i': { provider: 'kie', model: 'gpt-image-2-image-to-image', type: 'image-to-image' },
  'gpt-image-2-openai-t2i': { provider: 'openai', type: 'text-to-image' },
  'gpt-image-2-openai-i2i': { provider: 'openai', type: 'image-to-image' },
};

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`thumb-img:${getClientIP(req)}`, 5, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    const { model, prompt, referenceImageUrl } = await req.json();

    if (!model || !prompt) {
      return NextResponse.json({ error: 'model and prompt are required' }, { status: 400 });
    }

    const config = MODEL_MAP[model];
    if (!config) {
      return NextResponse.json({ error: `Unknown model: ${model}. Valid: ${Object.keys(MODEL_MAP).join(', ')}` }, { status: 400 });
    }

    if (config.type === 'image-to-image' && !referenceImageUrl) {
      return NextResponse.json({ error: 'Reference image is required for image-to-image models. Upload an image or paste a URL.' }, { status: 400 });
    }

    // Validate reference URL to prevent SSRF
    if (referenceImageUrl) {
      try {
        const refUrl = new URL(referenceImageUrl);
        if (refUrl.protocol !== 'https:') {
          return NextResponse.json({ error: 'referenceImageUrl must use HTTPS' }, { status: 400 });
        }
        // Block private/internal IPs
        const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]', 'metadata.google.internal'];
        const h = refUrl.hostname;
        const isPrivate = blocked.some(b => h === b)
          || h.startsWith('10.')
          || h.startsWith('192.168.')
          || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
          || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
          || h.endsWith('.internal') || h.endsWith('.local');
        if (isPrivate) {
          return NextResponse.json({ error: 'referenceImageUrl points to a private address' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'referenceImageUrl is not a valid URL' }, { status: 400 });
      }
    }

    if (config.provider === 'openai') {
      // Sync OpenAI direct path. For i2i, fetch the reference bytes; for
      // t2i, no reference needed. Upload the returned PNG to R2 so we
      // return a permanent URL (matching the Kie response shape).
      let referenceImage: { bytes: Buffer; mimeType: string; filename: string } | undefined;
      if (config.type === 'image-to-image' && referenceImageUrl) {
        const refRes = await fetch(referenceImageUrl);
        if (!refRes.ok) {
          throw new Error(`Failed to fetch reference image (HTTP ${refRes.status}).`);
        }
        const arrayBuf = await refRes.arrayBuffer();
        if (arrayBuf.byteLength > 8 * 1024 * 1024) {
          throw new Error('Reference image exceeds 8 MB cap for the OpenAI edit path.');
        }
        const ct = refRes.headers.get('content-type') || 'image/png';
        const mimeType = ct.includes('png')
          ? 'image/png'
          : ct.includes('webp')
            ? 'image/webp'
            : ct.includes('gif')
              ? 'image/gif'
              : 'image/jpeg';
        referenceImage = { bytes: Buffer.from(arrayBuf), mimeType, filename: 'reference.png' };
      }
      const result = await generateImageOpenAI({
        prompt,
        size: '2048x1152', // true 16:9 — only OpenAI size matching YouTube thumbnail aspect
        quality: 'medium',
        referenceImage,
      });
      const bytes = Buffer.from(result.base64, 'base64');
      const r2Key = `thumbnails/freeform-openai/${randomUUID()}.png`;
      await uploadToBucket(getImagesBucket(), r2Key, bytes, 'image/png');
      const imageUrl = await getImagesDownloadUrl(r2Key);
      return NextResponse.json({ imageUrl, taskId: null });
    }

    // Kie.ai path (default).
    const apiKey = requireKieKey();

    // Build request body. GPT Image 2 doesn't document an nsfw_checker
    // field (per Kie market spec) — including it risks a 422 on stricter
    // validators. Every other Kie image model accepts it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input: Record<string, any> = { prompt };
    if (!config.model.startsWith('gpt-image-2')) {
      input.nsfw_checker = true;
    }

    // Text-to-image models
    if (config.type === 'text-to-image') {
      if (config.model.startsWith('flux-2')) {
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
      } else if (config.model.startsWith('google/')) {
        input.image_size = '16:9';
        input.output_format = 'png';
      } else if (config.model.startsWith('gpt-image-2')) {
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
      } else {
        input.aspect_ratio = '16:9';
      }
    }

    // Image-to-image models — add reference image. GPT Image 2 expects
    // `input_urls`; everything else uses `image_urls`. Both are arrays.
    if (config.type === 'image-to-image') {
      if (config.model === 'gpt-image-2-image-to-image') {
        input.input_urls = [referenceImageUrl];
      } else {
        input.image_urls = [referenceImageUrl];
      }
    }

    const taskId = await createKieTask(apiKey, config.model, input);
    const imageUrl = await pollKieResult(taskId, apiKey);

    return NextResponse.json({ imageUrl, taskId });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'thumbnails: image generate',
      knownPatterns: [
        // requireKieKey throws this when the env var is missing
        { match: /KIE_API_KEY environment variable is not configured/, status: 500 },
        // Kie.ai upstream availability messages thrown explicitly above
        { match: /Kie\.ai is temporarily unavailable/, status: 503 },
      ],
      fallbackMessage: 'Image generation failed — please try again.',
    });
  }
}
