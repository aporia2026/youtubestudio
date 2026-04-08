import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 120;

/**
 * Kie.ai image generation model configurations.
 */
const MODEL_MAP: Record<string, { model: string; type: 'text-to-image' | 'image-to-image' }> = {
  'grok-imagine-t2i': { model: 'grok-imagine/text-to-image', type: 'text-to-image' },
  'flux2-pro-t2i': { model: 'flux-2/pro-text-to-image', type: 'text-to-image' },
  'flux2-flex-t2i': { model: 'flux-2/flex-text-to-image', type: 'text-to-image' },
  'nano-banana': { model: 'google/nano-banana', type: 'text-to-image' },
  'nano-banana-2': { model: 'google/nanobanana2', type: 'text-to-image' },
  'grok-imagine-i2i': { model: 'grok-imagine/image-to-image', type: 'image-to-image' },
  'flux2-pro-i2i': { model: 'flux-2/pro-image-to-image', type: 'image-to-image' },
  'flux2-flex-i2i': { model: 'flux-2/flex-image-to-image', type: 'image-to-image' },
  'pro-i2i': { model: 'google/pro-image-to-image', type: 'image-to-image' },
};

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

/**
 * Poll Kie.ai for task completion. Returns the image URL.
 */
async function pollForResult(taskId: string, apiKey: string, maxAttempts = 30): Promise<string> {
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
        const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]'];
        if (blocked.some(b => refUrl.hostname === b) || refUrl.hostname.startsWith('10.') || refUrl.hostname.startsWith('192.168.')) {
          return NextResponse.json({ error: 'referenceImageUrl points to a private address' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'referenceImageUrl is not a valid URL' }, { status: 400 });
      }
    }

    const apiKey = requireKieKey();

    // Build request body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input: Record<string, any> = {
      prompt,
      nsfw_checker: false,
    };

    // Text-to-image models
    if (config.type === 'text-to-image') {
      if (config.model.startsWith('flux-2')) {
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
      } else if (config.model.startsWith('google/')) {
        input.image_size = '16:9';
        input.output_format = 'png';
      } else {
        input.aspect_ratio = '16:9';
      }
    }

    // Image-to-image models — add reference image
    if (config.type === 'image-to-image') {
      input.image_urls = [referenceImageUrl];
    }

    // Create task
    const createRes = await fetch(`${KIE_BASE}/createTask`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Kie.ai task creation failed (${createRes.status}): ${errText}`);
    }

    const createData = await createRes.json();
    const taskId = createData.data?.taskId;

    if (!taskId) {
      throw new Error('No taskId returned from Kie.ai');
    }

    // Poll for completion
    const imageUrl = await pollForResult(taskId, apiKey);

    return NextResponse.json({ imageUrl, taskId });
  } catch (err: unknown) {
    console.error('Thumbnail image generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
