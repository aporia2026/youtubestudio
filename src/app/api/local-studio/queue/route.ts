/**
 * GET /api/local-studio/queue
 *
 * Returns the running + pending prompts so the UI can render a
 * persistent queue panel — what's executing now, how many are
 * stacked behind it, when to allow new submissions vs. queue them.
 *
 * Polled every 2 s by the page. Cheap call against ComfyUI's
 * `/queue` endpoint, normalised into the shape the React panel
 * expects so it never has to know ComfyUI's wire format.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { ComfyUIClient } from '@/lib/comfyui/client';

export const GET = apiRoute.public(async () => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const client = new ComfyUIClient();
  try {
    const summary = await client.getQueueSummary();
    return NextResponse.json({
      ok: true,
      running: summary.running,
      pending: summary.pending,
      total: summary.running.length + summary.pending.length,
    });
  } catch {
    // ComfyUI unreachable — return an empty queue rather than 502.
    return NextResponse.json({
      ok: false,
      running: [],
      pending: [],
      total: 0,
    });
  }
});
