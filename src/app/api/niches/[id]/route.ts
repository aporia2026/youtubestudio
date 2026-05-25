import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const PATCH = apiRoute.authed(
  async (session, req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { is_active, name, description, keywords } = await req.json();
    try {
      const result = await sql`
        UPDATE niches SET
          is_active = COALESCE(${is_active}, is_active),
          name = COALESCE(${name}, name),
          description = COALESCE(${description}, description),
          keywords = COALESCE(${JSON.stringify(keywords)}, keywords)
        WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      if (result.rowCount === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    } catch (err) {
      logger.error('niches: update failed', { detail: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const result = await sql`
        DELETE FROM niches
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      if (result.rowCount === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    } catch (err) {
      logger.error('niches: delete failed', { detail: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);
