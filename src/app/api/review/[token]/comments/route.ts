import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, createComment, getComments } from '@/lib/review-db';
import { notifyReviewComment } from '@/lib/notify';

/** Verify a version belongs to the token's project */
async function verifyVersionOwnership(versionId: string, projectId: string): Promise<boolean> {
  const { rows } = await sql`
    SELECT 1 FROM review_versions WHERE id = ${versionId} AND project_id = ${projectId} LIMIT 1
  `;
  return rows.length > 0;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    const versionId = req.nextUrl.searchParams.get('versionId');
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });

    // Verify version belongs to this project
    if (!(await verifyVersionOwnership(versionId, link.project_id))) {
      return NextResponse.json({ error: 'Version not found in this project' }, { status: 403 });
    }

    const comments = await getComments(versionId);
    return NextResponse.json(comments);
  } catch (err) {
    console.error('GET comments error:', err);
    return NextResponse.json({ error: 'Failed to get comments' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    if (link.permission === 'view-only') {
      return NextResponse.json({ error: 'View-only access — cannot comment' }, { status: 403 });
    }

    const body = await req.json();
    const { version_id, timestamp_ms, text, author_name, author_color, drawing_data, drawing_thumbnail_url, parent_id } = body;

    if (!version_id || timestamp_ms == null || !text?.trim() || !author_name?.trim()) {
      return NextResponse.json({ error: 'version_id, timestamp_ms, text, and author_name are required' }, { status: 400 });
    }

    // Verify version belongs to this project
    if (!(await verifyVersionOwnership(version_id, link.project_id))) {
      return NextResponse.json({ error: 'Version not found in this project' }, { status: 403 });
    }

    if (drawing_data && link.permission !== 'can-annotate') {
      return NextResponse.json({ error: 'Annotation permission required to add drawings' }, { status: 403 });
    }

    const comment = await createComment({
      version_id,
      timestamp_ms,
      text: text.trim(),
      author_name: author_name.trim(),
      author_color: author_color || '#7c3aed',
      drawing_data,
      drawing_thumbnail_url,
      parent_id,
    });

    // Fire-and-forget email to the owner
    if (!parent_id) {
      // Look up project title + version number for the email
      sql`
        SELECT p.title AS project_title, v.version_number
        FROM review_versions v JOIN review_projects p ON p.id = v.project_id
        WHERE v.id = ${version_id}
      `.then(r => {
        const row = r.rows[0];
        if (!row) return;
        notifyReviewComment({
          projectId: link.project_id,
          projectTitle: row.project_title,
          versionId: version_id,
          versionNumber: row.version_number,
          authorName: author_name.trim(),
          text: text.trim(),
          timestampMs: timestamp_ms,
          drawingThumbnailUrl: drawing_thumbnail_url,
        }).catch(e => console.error('notifyReviewComment failed:', e));
      }).catch(() => {});
    }

    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    console.error('POST comment error:', err);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}
