import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

// Self-healing migration for newer per-project columns. Cheap (single
// IF NOT EXISTS ALTER per Lambda lifetime) so it's safe to keep here.
let columnsEnsured = false;
async function ensureColumns() {
  if (columnsEnsured) return;
  try {
    await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS youtube_description TEXT`;
    columnsEnsured = true;
  } catch {}
}

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      await ensureColumns();
      const result = await sql`
        SELECT * FROM projects
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (!result.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ project: result.rows[0] });
    } catch {
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);

export const PATCH = apiRoute.authed(
  async (session, req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { title, status, niche, topic } = await req.json();
    try {
      const result = await sql`
        UPDATE projects SET
          title = COALESCE(${title}, title),
          status = COALESCE(${status}, status),
          niche = COALESCE(${niche}, niche),
          topic = COALESCE(${topic}, topic),
          updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      if ((result.rowCount ?? 0) === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const result = await sql`
        DELETE FROM projects
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      if ((result.rowCount ?? 0) === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);
