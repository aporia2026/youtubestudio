import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const GET = apiRoute.authed(async (session, req) => {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
  const offset = parseInt(searchParams.get('offset') || '0');

  try {
    // `channels` is aggregated in a sub-select rather than via another
    // LEFT JOIN + GROUP BY because adding a join to a many-to-many would
    // multiply rows and break the script_count / media_count COUNTs.
    // COALESCE→'[]' so the client never sees null for an unlinked project.
    const result = await sql`
      SELECT
        p.*,
        COUNT(DISTINCT s.id) as script_count,
        COUNT(DISTINCT m.id) as media_count,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', c.id,
              'name', c.name,
              'account_color', c.account_color
            ) ORDER BY c.name)
            FROM project_channels pc
            JOIN channels c ON c.id = pc.channel_id
            WHERE pc.project_id = p.id
          ),
          '[]'::json
        ) as channels
      FROM projects p
      LEFT JOIN scripts s ON s.project_id = p.id
      LEFT JOIN media_assets m ON m.project_id = p.id
      WHERE p.workspace_id = ${session.ws}::uuid
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countResult = await sql`
      SELECT COUNT(*) as total FROM projects WHERE workspace_id = ${session.ws}::uuid
    `;
    return NextResponse.json({
      projects: result.rows,
      total: parseInt(countResult.rows[0]!.total as string),
    });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ projects: [], total: 0 });
  }
});

export const POST = apiRoute.authed(async (session, req) => {
  const { title, niche, topic, script, modelId } = await req.json();
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });

  try {
    // Project belongs to the session's workspace. workspace_id is NOT NULL
    // on this table since migration 0013 — must include it on insert.
    const projResult = await sql`
      INSERT INTO projects (title, niche, topic, status, workspace_id)
      VALUES (${title}, ${niche || ''}, ${topic || ''}, 'draft', ${session.ws}::uuid)
      RETURNING *
    `;
    const project = projResult.rows[0];

    let savedScript: { id: string; version: number } | null = null;
    if (script && project) {
      const words = countWords(script);
      const duration = estimateDuration(words);
      const scriptResult = await sql`
        INSERT INTO scripts
          (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active, workspace_id)
        VALUES
          (${project.id}, 1, ${script}, ${words}, ${duration}, ${modelId || null}, true, ${session.ws}::uuid)
        RETURNING id, version
      `;
      savedScript = scriptResult.rows[0] as { id: string; version: number };
      await sql`
        UPDATE projects SET status = 'in_progress', updated_at = NOW()
        WHERE id = ${project.id} AND workspace_id = ${session.ws}::uuid
      `;
    }

    return NextResponse.json({ project, script: savedScript });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('projects: create failed', { detail });
    return NextResponse.json(
      { error: `Failed to create project: ${detail}` },
      { status: 500 },
    );
  }
});
