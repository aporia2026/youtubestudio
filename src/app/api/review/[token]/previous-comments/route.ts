import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken } from '@/lib/review-db';
import { logger } from '@/lib/logger';

/**
 * Token-side mirror of the editor-dashboard previous-comments endpoint.
 *
 * Returns the unresolved top-level comments from the version BEFORE the
 * one supplied via ?versionId so the inline fix-notes modal can list each
 * piece of feedback to respond to.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    const versionId = req.nextUrl.searchParams.get('versionId');
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });

    // Confirm the version belongs to this share link's review project.
    const { rows: vRows } = await sql`
      SELECT version_number FROM review_versions
      WHERE id = ${versionId} AND project_id = ${link.project_id}
      LIMIT 1
    `;
    if (!vRows[0]) return NextResponse.json({ error: 'Version not in this project' }, { status: 403 });

    // Find the immediately-prior version.
    const { rows: prev } = await sql`
      SELECT id, version_number FROM review_versions
      WHERE project_id = ${link.project_id} AND version_number < ${vRows[0].version_number}
      ORDER BY version_number DESC
      LIMIT 1
    `;
    if (!prev[0]) return NextResponse.json({ previousVersion: null, comments: [] });

    const { rows: comments } = await sql`
      SELECT id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, drawing_thumbnail_url
      FROM review_comments
      WHERE version_id = ${prev[0].id}
        AND resolved = false
        AND parent_id IS NULL
        AND fix_for_comment_id IS NULL
      ORDER BY timestamp_ms ASC, created_at ASC
    `;

    return NextResponse.json({
      previousVersion: { id: prev[0].id, version_number: prev[0].version_number },
      comments,
    });
  } catch (err) {
    logger.error('GET token previous-comments error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
