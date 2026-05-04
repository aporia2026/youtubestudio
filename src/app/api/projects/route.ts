import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    const result = await sql`
      SELECT
        p.*,
        COUNT(DISTINCT s.id) as script_count,
        COUNT(DISTINCT m.id) as media_count
      FROM projects p
      LEFT JOIN scripts s ON s.project_id = p.id
      LEFT JOIN media_assets m ON m.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countResult = await sql`SELECT COUNT(*) as total FROM projects`;
    return NextResponse.json({ projects: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ projects: [], total: 0 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { title, niche, topic, script, modelId } = await req.json();
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });

    // Create project
    const projResult = await sql`
      INSERT INTO projects (title, niche, topic, status)
      VALUES (${title}, ${niche || ''}, ${topic || ''}, 'draft')
      RETURNING *
    `;
    const project = projResult.rows[0];

    // If a script is provided, save it
    let savedScript: { id: string; version: number } | null = null;
    if (script) {
      const words = countWords(script);
      const duration = estimateDuration(words);
      const scriptResult = await sql`
        INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active)
        VALUES (${project.id}, 1, ${script}, ${words}, ${duration}, ${modelId || null}, true)
        RETURNING id, version
      `;
      savedScript = scriptResult.rows[0] as { id: string; version: number };
      await sql`UPDATE projects SET status = 'in_progress', updated_at = NOW() WHERE id = ${project.id}`;
    }

    return NextResponse.json({ project, script: savedScript });
  } catch (err: unknown) {
    console.error('POST /api/projects failed:', err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to create project: ${detail}` }, { status: 500 });
  }
}
