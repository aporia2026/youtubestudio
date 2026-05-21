/**
 * POST /api/local-studio/cancel
 *
 * Interrupt the currently-running ComfyUI prompt and clear the queue.
 * ComfyUI executes one prompt at a time, so a global interrupt is the
 * right granularity — there's no per-prompt cancel ID beyond what's
 * already running.
 *
 * The browser-side flow also aborts the in-flight POST /generate via
 * AbortController so the user doesn't wait on a stuck response.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { ComfyUIClient } from '@/lib/comfyui/client';
import { logger } from '@/lib/logger';

export const POST = apiRoute.public(async () => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const client = new ComfyUIClient();
  // Best-effort: don't fail the route if ComfyUI is unreachable — the
  // user's request was "stop", and a failed cancel against a dead
  // backend already accomplishes that.
  const [interrupted, cleared] = await Promise.all([
    client.interrupt().catch(() => false),
    client.clearQueue().catch(() => false),
  ]);

  logger.info('[local-studio cancel] done', { interrupted, cleared });
  return NextResponse.json({ ok: true, interrupted, cleared });
});
