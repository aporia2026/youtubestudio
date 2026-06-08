import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  createBatch,
  listBatchesForWorkspace,
  type BatchIdeaInput,
} from '@/lib/shorts-batches';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';

/**
 * GET /api/shorts/batches
 *
 * Recent batches for the current workspace, newest first. Drives the
 * dashboard list — no per-short data is loaded; that comes from the
 * detail route.
 */
export const GET = apiRoute.authed(async (session) => {
  const batches = await listBatchesForWorkspace(session.ws);
  return NextResponse.json({ batches });
});

/**
 * POST /api/shorts/batches
 *
 * Create a new batch + N placeholder shorts from the user's selected
 * ideas. Validates channel ownership (the upload target must be a
 * workspace-scoped channel). The orchestrator picks up the batch on
 * the next cron tick — the response returns immediately with the new
 * batch id so the UI can route to the progress screen.
 *
 * Body shape:
 *   channelId:   required (UUID of a workspace-owned channel)
 *   defaults:    required ShortsBatchDefaults
 *   ideaInputs:  required array of BatchIdeaInput, ≥1 entry
 *   name?:       optional batch label
 *   projectId?:  optional project to scope the new shorts under
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    channelId?: string;
    defaults?: ShortsBatchDefaults;
    ideaInputs?: BatchIdeaInput[];
    name?: string;
    projectId?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.channelId || typeof body.channelId !== 'string') {
    return NextResponse.json({ error: 'channelId required' }, { status: 400 });
  }
  if (!body.defaults || typeof body.defaults !== 'object') {
    return NextResponse.json({ error: 'defaults required' }, { status: 400 });
  }
  if (!Array.isArray(body.ideaInputs) || body.ideaInputs.length === 0) {
    return NextResponse.json({ error: 'ideaInputs must be a non-empty array' }, { status: 400 });
  }
  for (const [i, idea] of body.ideaInputs.entries()) {
    if (!idea.ideaTitle || !idea.hook || !idea.payoff || !idea.niche) {
      return NextResponse.json(
        { error: `ideaInputs[${i}] missing required fields (ideaTitle, hook, payoff, niche)` },
        { status: 400 },
      );
    }
  }

  // Channel ownership check — never trust a client-supplied channel
  // id; verify it belongs to the caller's workspace before any token
  // resolution happens downstream.
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM channels
     WHERE id = ${body.channelId}::uuid AND workspace_id = ${session.ws}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Channel not found in this workspace' }, { status: 404 });
  }

  if (body.projectId) {
    const { rows: prj } = await sql<{ id: string }>`
      SELECT id FROM projects
       WHERE id = ${body.projectId}::uuid AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (prj.length === 0) {
      return NextResponse.json({ error: 'Project not found in this workspace' }, { status: 404 });
    }
  }

  const { batchId, shortIds } = await createBatch({
    workspaceId: session.ws,
    channelId: body.channelId,
    createdBy: session.uid,
    name: body.name ?? null,
    defaults: body.defaults,
    ideaInputs: body.ideaInputs,
    projectId: body.projectId ?? null,
  });

  logger.info('[shorts-batch create]', {
    batch_id: batchId,
    workspace_id: session.ws,
    channel_id: body.channelId,
    idea_count: body.ideaInputs.length,
    short_ids: shortIds,
  });

  return NextResponse.json({ batchId, shortIds }, { status: 201 });
});
