import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { processBatchTick } from '@/lib/shorts-batch-orchestrator';

/**
 * POST /api/shorts/batches/[id]/run-tick
 *
 * Drains one tick of the orchestrator for the batch. The step-3
 * progress UI calls this on a 4s interval; a future cron can call
 * the same endpoint with a service token to drive batches without
 * an open tab.
 *
 * Forwards the caller's session cookie to processBatchTick so the
 * trigger_render stage can call /api/render/short with the same
 * auth.
 *
 * Idempotent — calling twice in succession is safe. When there are
 * no more shorts to advance the response carries `claimed: 0,
 * advanced: 0`.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    const result = await processBatchTick({
      batchId: id,
      workspaceId: session.ws,
      sessionCookie,
    });
    return NextResponse.json(result);
  },
);
