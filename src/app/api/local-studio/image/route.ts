/**
 * GET /api/local-studio/image?filename=&subfolder=&type=
 *
 * Proxy a ComfyUI output image through Next.js so the browser never
 * talks to `127.0.0.1:8188` directly. Avoids browser blocks (Chrome
 * security extensions, HSTS, etc) and keeps the ComfyUI port hidden
 * from the page.
 *
 * Also positions us for Phase 4 — when a row attaches a generation to
 * a project, we'll re-upload through this same route into Vercel Blob
 * so the URL works across devices.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { ComfyUIClient } from '@/lib/comfyui/client';

export const GET = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const filename = url.searchParams.get('filename');
  const subfolder = url.searchParams.get('subfolder') ?? '';
  const type = url.searchParams.get('type') ?? 'output';

  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  // Defensive: reject path traversal in filename / subfolder. ComfyUI
  // itself validates internally, but the proxy is a public-facing
  // route (relative to the dev server) so it gets its own guards.
  if (
    filename.includes('..') ||
    filename.includes('\\') ||
    subfolder.includes('..') ||
    subfolder.includes('\\')
  ) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  if (type !== 'output' && type !== 'temp' && type !== 'input') {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const client = new ComfyUIClient();
  const { bytes, contentType } = await client.fetchOutputBytes({
    filename,
    subfolder,
    type,
  });
  return new NextResponse(bytes, {
    headers: {
      'content-type': contentType,
      // Generation outputs are immutable — same filename always points
      // at the same bytes. Cache aggressively in the browser.
      'cache-control': 'private, max-age=3600',
    },
  });
});
