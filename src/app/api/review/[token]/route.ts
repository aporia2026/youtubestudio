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

    return NextResponse.json({
      project: {
        id: link.project_id,
        title: link.project_title,
        description: link.project_description,
        status: link.project_status,
      },
      permission: link.permission,
      versions: versionsWithUrls,
      comments,
    });
  } catch (err) {
    console.error('GET /api/review/[token] error:', err);
    return NextResponse.json({ error: 'Failed to load review' }, { status: 500 });
  }
}
