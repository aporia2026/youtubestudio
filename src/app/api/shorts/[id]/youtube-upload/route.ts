import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { uploadSingleShort } from '@/lib/shorts-batch-uploader';

/**
 * POST /api/shorts/[id]/youtube-upload
 *
 * One-off upload of a single short to YouTube. Used by the per-card
 * "Upload" button in the review queue, and by the per-short retry
 * surface after a failed batch upload.
 *
 * Body:
 *   channelId — required (workspace-owned channel UUID). The route
 *               verifies ownership before issuing the OAuth call.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: { channelId?: string } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body.channelId) {
      return NextResponse.json({ error: 'channelId required' }, { status: 400 });
    }

    // Workspace-scoped channel ownership check. Never trust the
    // client-supplied id — re-verify before any OAuth resolution.
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM channels
       WHERE id = ${body.channelId}::uuid AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Channel not found in this workspace' }, { status: 404 });
    }

    const outcome = await uploadSingleShort({
      shortId: id,
      workspaceId: session.ws,
      channelId: body.channelId,
    });

    if (!outcome.ok) {
      return NextResponse.json(outcome, { status: 422 });
    }
    return NextResponse.json(outcome);
  },
);
