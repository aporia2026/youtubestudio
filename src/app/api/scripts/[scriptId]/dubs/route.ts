import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { listDubsForScript } from '@/lib/dubbing';

/**
 * GET /api/scripts/[scriptId]/dubs
 *
 * Returns every dub row for the script, ordered by target_language.
 * Workspace-scoped via the script's project. The UI uses this to poll
 * progress when running multi-language dubs in parallel.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ scriptId: string }> }) => {
    const { scriptId } = await ctx.params;

    // Verify the script belongs to the workspace before reading dubs —
    // dubs query is keyed on script_id but a stale client could probe
    // other-workspace scriptIds otherwise.
    const owns = await sql<{ id: string }>`
      SELECT s.id
        FROM scripts s
        JOIN projects p ON p.id = s.project_id
       WHERE s.id = ${scriptId}::uuid
         AND p.workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (owns.rows.length === 0) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const dubs = await listDubsForScript(scriptId, session.ws);
    return NextResponse.json({ dubs });
  },
);
