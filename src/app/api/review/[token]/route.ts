import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, getVersions, getCommentsForProject } from '@/lib/review-db';
import { buildReviewDownloadFilename, getDownloadAttachmentUrl, getDownloadPresignedUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

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

    // Generate presigned download URLs for each version. `video_url`
    // backs the <video> element (range playback) and may short-circuit
    // to the public R2 CDN; `download_url` is always a presigned URL
    // with `response-content-disposition` baked in so the browser saves
    // the bytes direct from R2 without routing through /api/download-
    // proxy — that proxy is killed by Vercel's 300s function timeout on
    // multi-GB renders.
    const versionsWithUrls = await Promise.all(
      versions.map(async (v) => ({
        ...v,
        video_url: v.r2_key ? await getDownloadPresignedUrl(v.r2_key) : null,
        download_url: v.r2_key
          ? await getDownloadAttachmentUrl(
              v.r2_key,
              buildReviewDownloadFilename(link.project_title, v.version_number),
            )
          : null,
      }))
    );

    // Look up the linked collaborator's role(s) so the client can decide
    // whether the resolve button + upload-corrected-version + narrator
    // portal links should appear. Personal_token is intentionally NOT
    // included in this response — it grants access to ALL the user's
    // other assignments, so we expose it only via server-side redirects
    // (see /api/review/[token]/narrator-portal).
    let canResolve = false;
    let collaboratorName: string | null = null;
    let collaboratorRoles: string[] = [];
    if (link.collaborator_id) {
      try {
        const { rows: collab } = await sql`
          SELECT name, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
        `;
        if (collab[0]) {
          collaboratorName = collab[0].name as string;
          collaboratorRoles = Array.isArray(collab[0].roles) && collab[0].roles.length > 0
            ? (collab[0].roles as string[])
            : (collab[0].role ? [collab[0].role as string] : []);
          canResolve = collaboratorRoles.includes('editor') || collaboratorRoles.includes('narrator');
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
      collaboratorRoles,
      versions: versionsWithUrls,
      comments,
    });
  } catch (err) {
    logger.error('GET /api/review/[token] error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to load review' }, { status: 500 });
  }
}
