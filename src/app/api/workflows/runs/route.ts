import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listActionRuns, runDueActions } from '@/lib/workflows';
import type { WorkflowActionRunRow } from '@/lib/workflows-types';

export const maxDuration = 60;

/**
 * GET /api/workflows/runs?ruleId=&status=&limit=
 *
 * Recent action runs in the workspace. Filter by rule + status.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const ruleId = searchParams.get('ruleId') || undefined;
  const status = searchParams.get('status') as WorkflowActionRunRow['status'] | null;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const allowedStatus =
    status === 'pending' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'skipped'
      ? status
      : undefined;
  const runs = await listActionRuns(session.ws, { ruleId, status: allowedStatus, limit });
  return NextResponse.json({ runs });
});

/**
 * POST /api/workflows/runs
 *
 * Manually drain the queue for this workspace. Same path the cron uses,
 * just scoped to the calling workspace. Useful for "test my rule now".
 */
export const POST = apiRoute.authed(async (session) => {
  const result = await runDueActions({ workspaceId: session.ws, limit: 25 });
  return NextResponse.json(result);
});
