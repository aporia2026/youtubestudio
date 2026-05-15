import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { buildKieImageInput, getImageModelSpec, DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/image-models';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

/** Strip HTML (Cloudflare gateway pages) from kie.ai error responses. */
async function kieErrorMsg(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return `Kie.ai is temporarily unavailable (${res.status}) — please try again in a moment`;
    }
    return `Kie.ai returned an unexpected gateway response (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string') return `Kie.ai: ${msg}`;
  } catch { /* not JSON */ }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

async function pollForResult(taskId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) continue; // rate limited — retry
      throw new Error(`Poll failed: ${res.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      // Transient bad response — keep polling
      continue;
    }

    const state = (data.data as Record<string, unknown>)?.state;

    if (state === 'success') {
      const dataObj = data.data as Record<string, unknown>;
      let parsed: Record<string, unknown>;
      try {
        parsed = typeof dataObj.resultJson === 'string'
          ? JSON.parse(dataObj.resultJson)
          : (dataObj.resultJson as Record<string, unknown>);
      } catch {
        throw new Error('Invalid result JSON from Kie.ai');
      }
      const urls = parsed?.resultUrls as string[] | undefined;
      if (!urls?.length) throw new Error('No image URLs in result');
      return urls[0];
    }

    if (state === 'fail') {
      const dataObj = data.data as Record<string, unknown>;
      throw new Error((dataObj?.failMsg as string) || 'Image generation failed on Kie.ai');
    }
    // waiting / queuing / generating — keep polling
  }

  throw new Error('Image generation timed out after 90 s — try again');
}

export async function POST(req: NextRequest) {
  try {
    // Separate rate limit key from thumbnails; higher ceiling for bulk generation
    const { limited } = checkRateLimit(`prodoc-img:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    let body: { prompt?: string; model?: string; onScreenText?: string; sectionTitle?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { prompt, model, onScreenText, sectionTitle } = body;
    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // Safe-top directive — when the row will have a section-title stripe
    // overlay at render time (sectionTitle non-empty), bias the image's
    // composition so the top 13% is deliberate negative space (sky,
    // gradient, plain background). The stripe then sits on intentional
    // empty space instead of covering focal content. The exact 13%
    // matches the stripe's default heightFraction in SectionTitleStripe.
    const hasSectionStripe = Boolean(sectionTitle?.trim());
    const safeTopDirective = hasSectionStripe
      ? `LAYOUT CONSTRAINT — Leave the top 13% of the frame as deliberate negative space (sky, gradient, plain background, or low-detail texture). A white title stripe will overlay this area at render time. Do NOT place focal subjects, faces, brand marks, characters, or important details in the top 13%; compose all critical content in the lower 87% of the frame.\n\n`
      : '';

    // Bake the row's on-screen text into the image itself rather than render
    // it as a post-hoc lower-third. Kept SHORT (~120 chars) because some
    // Kie models truncate aggressively past a few hundred chars and the
    // scene description matters more than the directive's verbosity.
    // No manual quote escape — JSON.stringify in the fetch body handles
    // it. Sanitise stray newlines so the directive can't be smuggled
    // out of the prompt by a malformed OST string.
    const safeOnScreenText = (onScreenText ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
    const ostDirective = safeOnScreenText
      ? `Title text to render integrated into the scene as designed typography (legible, matches the illustration style, placed in the prompt's negative-space area): "${safeOnScreenText}". `
      : '';

    const augmentedPrompt = `${safeTopDirective}${ostDirective}${prompt.trim()}`;

    // Length cap applies to what we ACTUALLY send to Kie — the augmented
    // prompt — not the original. Raised to 2000 to leave room for the
    // OST directive overhead (~150 chars) on top of the existing budget.
    if (augmentedPrompt.length > 2000) {
      return NextResponse.json({ error: 'Prompt too long — maximum 2000 characters' }, { status: 400 });
    }

    const modelValue = model?.trim() || DEFAULT_IMAGE_MODEL;
    const spec = getImageModelSpec(modelValue);
    if (!spec) {
      return NextResponse.json(
        { error: `Unknown image model: ${modelValue}. Valid: ${IMAGE_MODELS.map(m => m.value).join(', ')}` },
        { status: 400 },
      );
    }

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
    }

    // Retry task creation up to 3× on transient 502/503/504 gateway errors
    let createRes!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      createRes = await fetch(`${KIE_BASE}/createTask`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: spec.kieModel,
          input: buildKieImageInput(spec.value, augmentedPrompt),
        }),
      });
      if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
    }

    if (!createRes.ok) {
      throw new Error(await kieErrorMsg(createRes));
    }

    let createData: Record<string, unknown>;
    try {
      createData = await createRes.json();
    } catch {
      throw new Error('Kie.ai returned non-JSON response during task creation');
    }

    const taskId = (createData.data as Record<string, unknown>)?.taskId as string | undefined;
    if (!taskId) throw new Error('No taskId returned from Kie.ai');

    const kieUrl = await pollForResult(taskId, apiKey);

    // Re-host in R2 (images bucket) so the URL doesn't depend on Kie's
    // CDN retention. On mirror failure fall back to the Kie URL —
    // image still usable until the upstream expires.
    let imageUrl = kieUrl;
    try {
      const imgRes = await fetch(kieUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = await imgRes.arrayBuffer();
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-${randomSuffix}.jpg`;
        await uploadToBucket(bucket, r2Key, Buffer.from(buffer), contentType);
        imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      }
    } catch (uploadErr) {
      console.warn('[image-gen] R2 upload failed, falling back to Kie.ai URL:', uploadErr);
    }

    return NextResponse.json({ imageUrl });
  } catch (err: unknown) {
    logger.error('Production doc image generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
