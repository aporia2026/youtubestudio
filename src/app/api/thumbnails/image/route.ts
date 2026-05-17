import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { domainErrorResponse } from '@/lib/route-helpers';

export const maxDuration = 300;

/**
 * Kie.ai image generation model configurations.
 *
 * Each entry maps our internal id → Kie's `model` string + the kind of input.
 * GPT Image 2 uses `input_urls` instead of `image_urls` for its image-to-image
 * variant — handled in the request builder below.
 */
const MODEL_MAP: Record<string, { model: string; type: 'text-to-image' | 'image-to-image' }> = {
  'grok-imagine-t2i': { model: 'grok-imagine/text-to-image', type: 'text-to-image' },
  'flux2-pro-t2i': { model: 'flux-2/pro-text-to-image', type: 'text-to-image' },
  'flux2-flex-t2i': { model: 'flux-2/flex-text-to-image', type: 'text-to-image' },
  'nano-banana': { model: 'google/nano-banana', type: 'text-to-image' },
  'gpt-image-2-t2i': { model: 'gpt-image-2-text-to-image', type: 'text-to-image' },
  'grok-imagine-i2i': { model: 'grok-imagine/image-to-image', type: 'image-to-image' },
  'flux2-pro-i2i': { model: 'flux-2/pro-image-to-image', type: 'image-to-image' },
  'flux2-flex-i2i': { model: 'flux-2/flex-image-to-image', type: 'image-to-image' },
  'gpt-image-2-i2i': { model: 'gpt-image-2-image-to-image', type: 'image-to-image' },
};

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

/**
 * Poll Kie.ai for task completion. Returns the image URL.
 *
 * Default ceiling: 95 × 3s = 285s — sits just under the route's
 * `maxDuration = 300`, leaving ~15s headroom for the work that runs
 * after the poll returns. Earlier default was 30 × 3s = 90s; Flux 2
 * Pro and GPT Image 2 routinely run longer than 90s, so the function
 * returned a timeout error while Kie kept running the job to
 * completion — burning credits we never collected a result for.
 */
async function pollForResult(taskId: string, apiKey: string, maxAttempts = 95): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second intervals

    const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) continue; // rate limited, retry
      throw new Error(`Task query failed: ${res.status}`);
    }

    const data = await res.json();
    const state = data.data?.state;

    if (state === 'success') {
      const resultJson = data.data?.resultJson;
      if (!resultJson) throw new Error('No result data in completed task');
      const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
      const urls = parsed.resultUrls;
      if (!urls?.length) throw new Error('No image URLs in result');
      return urls[0];
    }

    if (state === 'fail') {
      throw new Error(data.data?.failMsg || 'Image generation failed');
    }

    // waiting/queuing/generating — continue polling
  }

  throw new Error('Image generation timed out — try again');
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

    // Create task — retry up to 3× on transient gateway errors
    let createRes!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      createRes = await fetch(`${KIE_BASE}/createTask`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: config.model, input }),
      });
      if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
    }

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      const isHtml = body.trimStart().startsWith('<') || body.includes('</html>');
      const msg = isHtml
        ? `Kie.ai is temporarily unavailable (${createRes.status}) — please try again`
        : `Kie.ai task creation failed (${createRes.status}): ${body.slice(0, 200)}`;
      throw new Error(msg);
    }

    const createData = await createRes.json();
    const taskId = createData.data?.taskId;

    if (!taskId) {
      throw new Error('No taskId returned from Kie.ai');
    }

    // Poll for completion
    const imageUrl = await pollForResult(taskId, apiKey);

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
