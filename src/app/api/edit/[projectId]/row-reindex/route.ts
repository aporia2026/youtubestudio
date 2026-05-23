/**
 * POST /api/edit/[projectId]/row-reindex
 *
 * Propagate a client-side row insert / delete to the server's
 * `project_assets` table so the per-row keys stay in sync.
 *
 * Why this exists:
 *   Per-row asset URLs live in `project_assets` keyed by
 *   `(project_id, row_index, slot)`. When the editor inserts a blank
 *   shot at index N (or deletes the shot at index N), the client
 *   reindexes its in-memory asset maps so existing assets shift to
 *   match the new shot positions — but the server has no idea this
 *   happened. Without this endpoint, the next upload lands at the
 *   wrong index, and on reload the assets effectively "move" to
 *   neighbouring shots.
 *
 *   The old payload-jsonb storage hid this bug because the editor
 *   PATCH ignored incoming `rowImages` etc. by server contract — so
 *   the reindex never got persisted EITHER WAY (assets were always
 *   slightly off after insert/delete). Now that the storage is
 *   authoritative, this endpoint is mandatory.
 *
 *   See `_plans/2026-05-24-project-assets-extraction.md` §Reindex.
 *
 * Body:
 *   {
 *     op:      'insert' | 'delete',
 *     atIndex: number,    // the shot position where the op happened
 *   }
 *
 *   insert at N — every existing asset at row_index >= N shifts UP by 1.
 *   delete at N — the asset at row_index == N is removed, every asset
 *                 at row_index >  N shifts DOWN by 1.
 *
 * Response:
 *   200 { ok: true, version: number, affected: number } — new project
 *                                                          version + #
 *                                                          of rows shifted
 *   404 { error: '...' }    — project missing or out of scope
 *   400 { error: '...' }    — invalid body shape
 *
 * Auth: standard editor-project ownership via `apiRoute.authed` plus
 * the SQL WHERE clause's workspace_id + collaborator_id bind so a
 * leaked project id from another scope is indistinguishable from a
 * non-existent row.
 *
 * Per-IP rate limit: 240/min — same ceiling as row-asset; an insert
 * burst from a power user should not trip the limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { reindexProjectAssets, bumpProjectVersion } from '@/lib/project/assets';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROW_INDEX = 1000;

interface Body {
  op?: unknown;
  atIndex?: unknown;
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) => {
    const { limited } = checkRateLimit(`row-reindex:${getClientIP(req)}`, 240, 60_000);
    if (limited) {
      return NextResponse.json({ error: 'Too many reindex calls — slow down.' }, { status: 429 });
    }

    const { projectId } = await ctx.params;
    if (!UUID_RE.test(projectId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.op !== 'insert' && body.op !== 'delete') {
      return NextResponse.json(
        { error: "op must be 'insert' | 'delete'" },
        { status: 400 },
      );
    }
    const op = body.op as 'insert' | 'delete';

    if (typeof body.atIndex !== 'number' || !Number.isInteger(body.atIndex) || body.atIndex < 0 || body.atIndex > MAX_ROW_INDEX) {
      return NextResponse.json(
        { error: `atIndex must be an integer in [0, ${MAX_ROW_INDEX}]` },
        { status: 400 },
      );
    }
    const atIndex = body.atIndex;

    // Verify project ownership + scope before mutating project_assets.
    const ownership = await sql<{ id: string }>`
      SELECT id
        FROM user_history
       WHERE id = ${projectId}::uuid
         AND workspace_id = ${session.ws}::uuid
         AND collaborator_id = ${session.uid}::uuid
         AND kind = 'production_doc'
       LIMIT 1
    `;
    if (ownership.rows.length === 0) {
      logger.info('[row-reindex] not found', { project_id: projectId });
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    logger.info('[row-reindex] start', {
      project_id: projectId,
      workspace_id: session.ws,
      op,
      at_index: atIndex,
    });

    let affected = 0;
    try {
      const result = await reindexProjectAssets(projectId, op, atIndex);
      affected = result.affected;
    } catch (err) {
      logger.error('[row-reindex] failed', {
        project_id: projectId,
        op,
        at_index: atIndex,
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Reindex failed' }, { status: 500 });
    }

    const newVersion = await bumpProjectVersion(projectId);

    logger.info('[row-reindex] committed', {
      project_id: projectId,
      op,
      at_index: atIndex,
      affected,
      new_version: newVersion,
    });
    return NextResponse.json({ ok: true, version: newVersion, affected });
  },
);
