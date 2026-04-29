import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, getVersions, getCommentsForProject } from '@/lib/review-db';
import { getDownloadPresignedUrl } from '@/lib/r2';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });
    }

    // Track access (fire-and-forget)
    sql`UPDATE review_share_links SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE token = ${token}`.catch(() => {});

    const versions = await getVersions(link.project_id);
    const comments = await getCommentsForProject(link.project_id);

    // Generate presigned download URLs for each version
    const versionsWithUrls = await Promise.all(
      versions.map(async (v) => ({
        ...v,
        video_url: v.r2_key ? await getDownloadPresignedUrl(v.r2_key) : null,
      }))
    );

    // Look up the linked collaborator's role(s) so the client can decide
    // whether the resolve button should be available. Editors and narrators
    // get to mark comments as fixed; reviewers/clients should reply instead.
    let canResolve = false;
    let collaboratorName: string | null = null;
    if (link.collaborator_id) {
      try {
        const { rows: collab } = await sql`
          SELECT name, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
        `;
        if (collab[0]) {
          collaboratorName = collab[0].name as string;
          const roles: string[] = Array.isArray(collab[0].roles) && collab[0].roles.length > 0
            ? collab[0].roles
            : (collab[0].role ? [collab[0].role] : []);
          canResolve = roles.includes('editor') || roles.includes('narrator');
        }
      } catch {}
    }

    return NextResponse.json({
      project: {
        id: link.project_id,
        title: link.project_title,
        description: link.project_description,
        status: link.project_status,
      },
      permission: link.permission,
      canResolve,
      collaboratorName,
      versions: versionsWithUrls,
      comments,
    });
  } catch (err) {
    console.error('GET /api/review/[token] error:', err);
    return NextResponse.json({ error: 'Failed to load review' }, { status: 500 });
  }
}
