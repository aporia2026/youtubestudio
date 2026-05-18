import { NextResponse } from 'next/server';
import { sql, ensureChannelNamesSchema } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * Audit: this route had ZERO auth — any caller could DELETE any
 * workspace's saved name by guessing the id. Now wrapped + workspace-
 * scoped: a stolen id from another tenant returns 404 (no leak of row
 * existence).
 */
export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    try {
      await ensureChannelNamesSchema();
      const result = await sql`
        DELETE FROM saved_channel_names
         WHERE id = ${id}
           AND workspace_id = ${session.ws}::uuid
      `;
      if ((result.rowCount ?? 0) === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channel-naming: delete saved',
        fallbackMessage: 'Could not delete saved name — please try again.',
      });
    }
  },
);
