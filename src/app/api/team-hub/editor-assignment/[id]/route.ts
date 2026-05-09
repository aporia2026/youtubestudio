/**
 * PATCH /api/team-hub/editor-assignment/[id]
 *
 * Workspace-scoped wrapper around `updateEditorAssignment` for the team
 * hub. The legacy /api/projects/[id]/editors/[assignmentId] PATCH route
 * is unauthed (predates the Phase 1 auth gate sweep) and requires the
 * project id in the URL — neither serves the team hub well, so this
 * route owns the authed + tenancy-checked path.
 *
 * Accepts `status` and/or `deadline` in the body. Other fields are
 * ignored — the team hub's lightweight inline edits are deliberately
 * narrow.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { updateEditorAssignment } from '@/lib/editor-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUS = new Set(['assigned', 'editing', 'submitted', 'approved', 'completed']);

export const PATCH = apiRoute.authed<{ id: string }>(async (session, req, ctx) => {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 });
  }
  try {
    await assertOwnsResource('editor_assignments', id, session.ws);

    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      deadline?: string | null;
    };

    const fields: { status?: string; deadline?: string } = {};
    if (typeof body.status === 'string') {
      if (!ALLOWED_STATUS.has(body.status)) {
        return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
      }
      fields.status = body.status;
    }
    if (body.deadline === null || typeof body.deadline === 'string') {
      // Pass through null OR a date string; updateEditorAssignment uses
      // COALESCE so null leaves the column untouched. To explicitly
      // clear a deadline, callers should pass an empty string which we
      // forward as null.
      fields.deadline = body.deadline === null || body.deadline === '' ? undefined : body.deadline;
    }

    const updated = await updateEditorAssignment(id, fields);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    logger.error('PATCH /api/team-hub/editor-assignment/[id]', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      assignment_id: id,
    });
    return NextResponse.json({ error: 'Failed to update assignment' }, { status: 500 });
  }
});
