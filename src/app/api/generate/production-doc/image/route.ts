import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { put } from '@vercel/blob';
import { logger } from '@/lib/logger';

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

    let body: { prompt?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { prompt } = body;
    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }
    if (prompt.trim().length > 1500) {
      return NextResponse.json({ error: 'Prompt too long — maximum 1500 characters' }, { status: 400 });
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
          model: 'grok-imagine/text-to-image',
          input: {
            prompt: prompt.trim(),
            nsfw_checker: true,
            aspect_ratio: '16:9',
          },
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

    // Re-host in Vercel Blob so the URL never expires
    let imageUrl = kieUrl;
    try {
      const imgRes = await fetch(kieUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = await imgRes.arrayBuffer();
        const blob = await put(`prodoc-images/${Date.now()}.jpg`, buffer, {
          access: 'public',
          contentType,
          addRandomSuffix: true,
        });
        imageUrl = blob.url;
      }
    } catch (uploadErr) {
      console.warn('[image-gen] Vercel Blob upload failed, falling back to Kie.ai URL:', uploadErr);
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
