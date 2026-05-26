import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureDraftsSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/** GET /api/drafts — scoped to the caller's workspace. workflow_drafts
 *  is a root tenant table; the prior unscoped GET silently leaked
 *  drafts across workspaces (now fixed alongside the POST). */
export const GET = apiRoute.authed(async (session) => {
  try {
    await ensureDraftsSchema();
    const result = await sql`
      SELECT id, title, niche, step, data, updated_at, created_at
      FROM workflow_drafts
      WHERE workspace_id = ${session.ws}::uuid
      ORDER BY updated_at DESC
      LIMIT 50
    `;
    // Merge the stored `data` blob back into a flat WorkflowDraft shape
    const drafts = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      niche: row.niche,
      step: row.step,
      updatedAt: new Date(row.updated_at).getTime(),
      ...row.data,
    }));
    return NextResponse.json({ drafts });
  } catch (err) {
    logger.error('GET /api/drafts error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ drafts: [] });
  }
});

/** POST /api/drafts — upsert a workflow draft in the caller's
 *  workspace. workspace_id is NOT NULL on workflow_drafts. */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  try {
    await ensureDraftsSchema();
    const draft = await req.json();
    if (!draft.id || !draft.title) {
      return NextResponse.json({ error: 'id and title are required' }, { status: 400 });
    }

    // Store everything except the top-level indexed columns inside `data`
    const { id, title, niche, step, updatedAt, ...rest } = draft;
    const data = rest;

    await sql`
      INSERT INTO workflow_drafts (id, title, niche, step, data, updated_at, workspace_id)
      VALUES (
        ${id},
        ${title || ''},
        ${niche || ''},
        ${step || 'idea'},
        ${JSON.stringify(data)},
        ${new Date(updatedAt || Date.now()).toISOString()},
        ${session.ws}::uuid
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        niche = EXCLUDED.niche,
        step = EXCLUDED.step,
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('POST /api/drafts error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to save draft' }, { status: 500 });
  }
});
