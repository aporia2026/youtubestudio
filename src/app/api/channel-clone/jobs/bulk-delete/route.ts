/**
 * POST /api/channel-clone/jobs/bulk-delete
 *
 * Body — one of:
 *   { ids: string[] }            — delete specific job ids (max 200)
 *   { scope: 'failed' }          — delete every *_failed + cancelled job
 *   { scope: 'all' }             — delete every job in the workspace
 *
 * Workspace-scoped: a cross-tenant id silently no-ops (returns
 * `deleted: 0` for that id). Auth enforced by `apiRoute.authed`.
 *
 * Running jobs whose rows are deleted will silently exit when their
 * next DB call returns no rows (the runner already handles "job
 * vanished mid-run" without crashing). The sandbox they own then
 * auto-reaps on its own lifetime timeout — CPU is wasted for at
 * most a few minutes, never leaked permanently.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { bulkDeleteChannelCloneJobs } from '@/lib/channel-clone/job-store';
import { deleteR2Prefix } from '@/lib/channel-clone/templates-r2';
import { logger } from '@/lib/logger';

export const maxDuration = 15;

const MAX_BULK_IDS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // Mode 1: explicit ids.
  if (Array.isArray(b.ids)) {
    const ids = b.ids;
    if (ids.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }
    if (ids.length > MAX_BULK_IDS) {
      return NextResponse.json(
        { error: `ids array exceeds ${MAX_BULK_IDS} entries — split the request` },
        { status: 400 },
      );
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        return NextResponse.json(
          { error: 'every id must be a valid UUID string' },
          { status: 400 },
        );
      }
    }
    const deletedIds = await bulkDeleteChannelCloneJobs(session.ws, { ids: ids as string[] });
    logger.info('[channel-clone bulk-delete] by ids', {
      workspaceId: session.ws,
      requested: ids.length,
      deleted: deletedIds.length,
    });
    fireStagingCleanup(session.ws, deletedIds);
    return NextResponse.json({ deleted: deletedIds.length });
  }

  // Mode 2: scope.
  if (b.scope === 'all' || b.scope === 'failed') {
    const deletedIds = await bulkDeleteChannelCloneJobs(session.ws, { scope: b.scope });
    logger.info('[channel-clone bulk-delete] by scope', {
      workspaceId: session.ws,
      scope: b.scope,
      deleted: deletedIds.length,
    });
    fireStagingCleanup(session.ws, deletedIds);
    return NextResponse.json({ deleted: deletedIds.length });
  }

  return NextResponse.json(
    { error: 'body must include either `ids` (array) or `scope` ("all" | "failed")' },
    { status: 400 },
  );
});

/** Fire-and-forget cleanup of the per-job staging-prefix R2 objects
 *  for every id that was actually deleted. Mirrors the per-job
 *  DELETE handler. Per-job errors are swallowed so a slow R2 doesn't
 *  block the route response. */
function fireStagingCleanup(workspaceId: string, deletedIds: string[]): void {
  for (const id of deletedIds) {
    void deleteR2Prefix(`channel-clone-uploads-staging/${workspaceId}/${id}/`).catch((err) => {
      logger.warn('[channel-clone bulk-delete] staging cleanup failed for id', {
        jobId: id, error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
