import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * GET /api/scripts/[scriptId]
 *
 * Direct script fetch by id, used as a fallback path when a schedule item
 * carries a script_id but no project_id and the schedule-link preload
 * therefore can't go through /api/projects/[id]/scripts. Returns 404 for
 * scripts in other workspaces to avoid a cross-workspace info leak.
 */
export const GET = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ scriptId: string }> }) => {
    const { scriptId } = await ctx.params;
    const result = await sql`
      SELECT id, project_id, version, content,
             word_count, estimated_duration_seconds,
             is_active, created_at
        FROM scripts
       WHERE id = ${scriptId}::uuid
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ script: result.rows[0] });
  },
);
