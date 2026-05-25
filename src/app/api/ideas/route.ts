import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const GET = apiRoute.authed(async (session, req) => {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = await sql`
      SELECT * FROM video_ideas
       WHERE is_saved = true AND workspace_id = ${session.ws}::uuid
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
    const countResult = await sql`
      SELECT COUNT(*) as total FROM video_ideas
       WHERE is_saved = true AND workspace_id = ${session.ws}::uuid
    `;
    return NextResponse.json({ ideas: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) {
    logger.error('GET /api/ideas error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ideas: [], total: 0 });
  }
});

export const POST = apiRoute.authed(async (session, req) => {
  const idea = await req.json();
  try {
    const result = await sql`
      INSERT INTO video_ideas (
        niche, title, hook, description, target_audience,
        estimated_views_potential, trend_relevance, difficulty,
        tags, is_saved, workspace_id
      )
      VALUES (
        ${idea.niche || ''},
        ${idea.title},
        ${idea.hook || ''},
        ${idea.description || idea.why_it_will_perform || ''},
        ${idea.target_audience_segment || ''},
        ${idea.estimated_views_potential || ''},
        ${idea.trend_status || ''},
        ${idea.estimated_difficulty || ''},
        ${JSON.stringify(idea.tags || [])},
        true,
        ${session.ws}::uuid
      )
      RETURNING *
    `;
    return NextResponse.json({ idea: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/ideas error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
});
