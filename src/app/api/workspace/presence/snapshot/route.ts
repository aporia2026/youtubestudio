/**
 * GET /api/workspace/presence/snapshot
 *
 * Read-only snapshot of the workspace's current presence. Used by the
 * Command Center kanban which polls more frequently than it heartbeats
 * (it shows everyone's badges, but no one is "open on the kanban"
 * itself — the kanban is a viewer, not a video).
 *
 * Cheap by design: pure in-memory read with a per-video sweep on the
 * way out. No DB roundtrip.
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { snapshotWorkspacePresence } from '@/lib/presence';

export const GET = apiRoute.authed(async (session) => {
  const presence = snapshotWorkspacePresence(session.ws);
  return NextResponse.json({ presence });
});
