import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { commitRanking, PipelineActionError } from '@/lib/auto-pipeline/actions';

/**
 * POST /api/auto-pipeline/runs/[id]/rank
 *
 * Body: `{ orderedVideoIds: string[] }` — the new priority order.
 * Validates exact coverage (no missing, no extras, no duplicates)
 * then flips status from idea_ranking → running so the cron
 * starts draining.
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
  const orderedVideoIds = Array.isArray(b.orderedVideoIds)
    ? b.orderedVideoIds.filter((x): x is string => typeof x === 'string')
    : null;
  if (!orderedVideoIds || orderedVideoIds.length === 0) {
    return NextResponse.json({ error: 'orderedVideoIds (string array) is required.' }, { status: 400 });
  }

  try {
    await commitRanking({ workspaceId: session.ws, runId, orderedVideoIds });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PipelineActionError) {
      const status = err.code === 'run_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return domainErrorResponse(err, {
      op: 'auto-pipeline: commit ranking',
      fallbackMessage: 'Failed to commit ranking.',
    });
  }
});
