import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * POST /api/shorts/[id]/dismiss
 *
 * Hides a `shorts` row from the global inbox by setting `dismissed_at`
 * to NOW(). The row is NOT deleted — the user can still see it on the
 * project detail page or grade it later. Inbox queries filter
 * `dismissed_at IS NULL`.
 *
 * Workspace-scoped: a dismiss for a row in another workspace returns
 * 404 (no info leak, matching the Phase 8.1 audit pattern).
 *
 * Idempotent: calling dismiss twice updates the timestamp to the
 * second call but never errors.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const { rowCount } = await sql`
        UPDATE shorts
           SET dismissed_at = NOW()
         WHERE id = ${id}::uuid
           AND workspace_id = ${session.ws}::uuid
      `;
      if (!rowCount || rowCount === 0) {
        return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      }
      logger.info('[shorts inbox dismiss]', {
        workspaceId: session.ws,
        shortId: id,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: dismiss',
        fallbackMessage: 'Failed to dismiss this Short.',
      });
    }
  },
);
