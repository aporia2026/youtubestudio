import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createComment } from '@/lib/review-db';
import { logger } from '@/lib/logger';

/** Owner-side: post a comment without needing a share token. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const { version_id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, drawing_data, drawing_thumbnail_url, parent_id } = body;

    if (!version_id || timestamp_ms == null || !text?.trim() || !author_name?.trim()) {
      return NextResponse.json({ error: 'version_id, timestamp_ms, text, and author_name are required' }, { status: 400 });
    }

    // Verify version belongs to this project
    const { rows } = await sql`
      SELECT 1 FROM review_versions WHERE id = ${version_id} AND project_id = ${projectId} LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Version not found in this project' }, { status: 403 });
    }

    const comment = await createComment({
      version_id,
      timestamp_ms,
      end_timestamp_ms: typeof end_timestamp_ms === 'number' ? end_timestamp_ms : null,
      text: text.trim(),
      author_name: author_name.trim(),
      author_color: author_color || '#7c3aed',
      author_role: 'owner',
      drawing_data,
      drawing_thumbnail_url,
      parent_id,
    });

    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    logger.error('POST owner comment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}
