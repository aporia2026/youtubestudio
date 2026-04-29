import { NextRequest, NextResponse } from 'next/server';
import { getProject, getVersions, getCommentsForProject } from '@/lib/review-db';
import { getDownloadPresignedUrl } from '@/lib/r2';

/**
 * Owner-side playback data — same shape as /api/review/[token] but
 * authenticated via session (the route is behind the proxy auth wall).
 * The owner always has full annotate permission.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const versions = await getVersions(id);
    const comments = await getCommentsForProject(id);

    const versionsWithUrls = await Promise.all(
      versions.map(async (v) => ({
        ...v,
        video_url: v.r2_key ? await getDownloadPresignedUrl(v.r2_key) : null,
      }))
    );

    return NextResponse.json({
      project: {
        id: project.id,
        title: project.title,
        description: project.description,
        status: project.status,
      },
      permission: 'can-annotate' as const,
      versions: versionsWithUrls,
      comments,
    });
  } catch (err) {
    console.error('GET playback error:', err);
    return NextResponse.json({ error: 'Failed to load playback' }, { status: 500 });
  }
}
