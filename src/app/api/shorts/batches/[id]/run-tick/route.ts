import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { processBatchTick } from '@/lib/shorts-batch-orchestrator';

/**
 * POST /api/shorts/batches/[id]/run-tick
 *
 * Drains one tick of the orchestrator for the batch. The step-3
 * progress UI calls this on a 2s interval; a future cron can call
 * the same endpoint with a service token to drive batches without
 * an open tab.
 *
 * Idempotent — calling twice in succession is safe. When there are
 * no more shorts to advance the response carries `claimed: 0,
 * advanced: 0`.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const result = await processBatchTick({ batchId: id, workspaceId: session.ws });
    return NextResponse.json(result);
  },
);
