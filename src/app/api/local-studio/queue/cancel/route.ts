/**
 * POST /api/local-studio/queue/cancel
 *
 * Cancel one specific queued prompt. Body shape:
 *   { promptId: string, isRunning: boolean }
 *
 * `isRunning: true` triggers a global ComfyUI `/interrupt` (the
 * running prompt has no per-id cancel). `isRunning: false` removes
 * the prompt from the pending list via `POST /queue { delete: [id] }`.
 *
 * The client passes the running-vs-pending flag because the queue
 * panel already knows which list the prompt was in — the server
 * would otherwise have to re-poll /queue to figure it out.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { ComfyUIClient } from '@/lib/comfyui/client';
import { logger } from '@/lib/logger';

export const POST = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: { promptId?: string; isRunning?: boolean };
  try {
    body = (await req.json()) as { promptId?: string; isRunning?: boolean };
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!body.promptId || typeof body.promptId !== 'string') {
    return NextResponse.json({ error: 'promptId is required' }, { status: 400 });
  }

  const client = new ComfyUIClient();
  const ok = await client.cancelPrompt(body.promptId, { isRunning: Boolean(body.isRunning) });
  logger.info('[local-studio queue-cancel] sent', {
    prompt_id: body.promptId,
    is_running: Boolean(body.isRunning),
    ok,
  });
  return NextResponse.json({ ok });
});
