import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';
import { resyncAssignmentSectionsIfStale } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

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

    const words = countWords(content);
    const duration = estimateDuration(words);

    // INSERT first, deactivate-others second. Order matters: if the second
    // statement fails we briefly have two active rows (recoverable on the
    // next save), but if we deactivated first and the INSERT failed we'd
    // leave the project with zero active rows and the UI would render
    // "(no script yet)" despite versions existing in the table.
    //
    // workspace_id is NOT NULL on scripts (migration 0013); we copy it from
    // the parent project so the route doesn't need session/auth context.
    const result = await sql`
      INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active, workspace_id)
      SELECT ${id}::uuid, ${nextVersion}, ${content}, ${words}, ${duration}, ${modelId || null}, true, p.workspace_id
        FROM projects p WHERE p.id = ${id}::uuid
      RETURNING *
    `;
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const newId = result.rows[0].id;
    await sql`UPDATE scripts SET is_active = false WHERE project_id = ${id} AND id <> ${newId}`;

    await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;

    // Re-sync any narrator assignments for this project against the freshly
    // saved script. The helper handles guardrails (skip if takes exist, skip
    // if past recording) and is also called lazily on the narrator-portal
    // load — calling it here just gets the update in front of the owner
    // immediately on the Narration tab without waiting for the next portal
    // visit.
    try {
      const { rows: assignments } = await sql`
        SELECT id FROM narrator_assignments
        WHERE project_id = ${id}
          AND status IN ('assigned', 'received', 'recording')
      `;
      for (const a of assignments) {
        await resyncAssignmentSectionsIfStale(a.id);
      }
    } catch (e) {
      console.warn('narrator section resync on script save failed:', e);
    }

    return NextResponse.json({ script: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/projects/:id/scripts error', { detail: err instanceof Error ? err.message : String(err) });
    const message = err instanceof Error ? err.message : 'Failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
