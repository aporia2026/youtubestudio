import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const GET = apiRoute.authed(async (session) => {
  try {
    const result = await sql`
      SELECT * FROM niches
       WHERE is_active = true AND workspace_id = ${session.ws}::uuid
       ORDER BY name
    `;
    return NextResponse.json({ niches: result.rows });
  } catch (err) {
    logger.error('niches: list failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ niches: [] });
  }
});

export const POST = apiRoute.authed(async (session, req) => {
  const { name, description, keywords } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  try {
    const result = await sql`
      INSERT INTO niches (name, description, keywords, workspace_id)
      VALUES (
        ${name},
        ${description || ''},
        ${JSON.stringify(keywords || [])},
        ${session.ws}::uuid
      )
      RETURNING *
    `;
    return NextResponse.json({ niche: result.rows[0] });
  } catch (err: unknown) {
    logger.error('niches: insert failed', { detail: err instanceof Error ? err.message : String(err) });
    // niches.name still carries a legacy global UNIQUE constraint — surface
    // collisions as 409 so the UI can show a meaningful message instead of
    // the generic "Failed to add niche".
    const message = err instanceof Error ? err.message : 'Failed';
    const isDuplicate = /duplicate key|unique constraint/i.test(message);
    return NextResponse.json(
      { error: isDuplicate ? 'A niche with this name already exists' : message },
      { status: isDuplicate ? 409 : 500 },
    );
  }
});
