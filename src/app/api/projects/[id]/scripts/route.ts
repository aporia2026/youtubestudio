import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`
      SELECT * FROM scripts WHERE project_id = ${id} ORDER BY version DESC
    `;
    return NextResponse.json({ scripts: result.rows });
  } catch {
    return NextResponse.json({ scripts: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { content, modelId } = await req.json();

  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });

  try {
    // Get next version number
    const versionResult = await sql`
      SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM scripts WHERE project_id = ${id}
    `;
    const nextVersion = versionResult.rows[0].next_version;

    // Deactivate previous scripts
    await sql`UPDATE scripts SET is_active = false WHERE project_id = ${id}`;

    const words = countWords(content);
    const duration = estimateDuration(words);

    const result = await sql`
      INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active)
      VALUES (${id}, ${nextVersion}, ${content}, ${words}, ${duration}, ${modelId || null}, true)
      RETURNING *
    `;

    await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;

    return NextResponse.json({ script: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
