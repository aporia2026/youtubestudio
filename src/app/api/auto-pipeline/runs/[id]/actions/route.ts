import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  stopAllInRun,
  retryStuckOrFailedInRun,
  PipelineActionError,
} from '@/lib/auto-pipeline/actions';

/**
 * POST /api/auto-pipeline/runs/[id]/actions
 *
 * Run-level batch actions. Mirrors the shape of the per-video
 * actions endpoint (single endpoint dispatched on `action`) so the
 * UI has one fetch shape for everything.
 *
 * Supported actions:
 *   - stop_all:    body = { action: 'stop_all', reason?: string }
 *       Cancels every non-terminal video in the run.
 *   - retry_stuck: body = { action: 'retry_stuck' }
 *       Resets every terminal-failure video and clears every
 *       zombie claim (claimed_at older than 5min). Healthy rows
 *       are left alone.
 */
export const POST = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id: runId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action : '';

  try {
    switch (action) {
      case 'stop_all': {
        const reason = typeof b.reason === 'string' ? b.reason : undefined;
        const result = await stopAllInRun({ workspaceId: session.ws, runId, reason });
        return NextResponse.json(result);
      }
      case 'retry_stuck': {
        const result = await retryStuckOrFailedInRun({ workspaceId: session.ws, runId });
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PipelineActionError) {
      const status = err.code === 'run_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return domainErrorResponse(err, {
      op: `auto-pipeline: run action ${action}`,
      fallbackMessage: 'Run action failed.',
    });
  }
});
