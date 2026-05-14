import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject, deleteProject, getVersions } from '@/lib/review-db';
import { buildReviewDownloadFilename, deleteR2Object, getDownloadAttachmentUrl } from '@/lib/r2';
import { notifyStatusChanged } from '@/lib/notify';
import { logger } from '@/lib/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const versions = await getVersions(id);
    // Per-version `download_url` for the admin per-version icon. Direct
    // R2 presigned URL with `response-content-disposition` baked in so we
    // skip the /api/download-proxy hop that Vercel kills at 300s on
    // multi-GB renders. The admin page does not need a playback URL here —
    // the play view loads its own data from /playback.
    const versionsWithDownloads = await Promise.all(
      versions.map(async (v) => ({
        ...v,
        download_url: v.r2_key
          ? await getDownloadAttachmentUrl(
              v.r2_key,
              buildReviewDownloadFilename(project.title, v.version_number),
            )
          : null,
      }))
    );
    return NextResponse.json({ project, versions: versionsWithDownloads });
  } catch (err) {
    logger.error('GET /api/review/projects/[id] error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to get project' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    // Capture old status for change detection
    const before = await getProject(id);
    const project = await updateProject(id, fields);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Fire-and-forget: notify collaborators if status actually changed
    if (before && fields.status && before.status !== project.status) {
      notifyStatusChanged({
        projectId: id,
        projectTitle: project.title,
        oldStatus: before.status,
        newStatus: project.status,
      }).catch(e => logger.error('notifyStatusChanged failed', { detail: e instanceof Error ? e.message : String(e) }));
    }

    return NextResponse.json(project);
  } catch (err) {
    logger.error('PATCH /api/review/projects/[id] error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Clean up R2 objects for all versions
    const versions = await getVersions(id);
    for (const v of versions) {
      if (v.r2_key) {
        try { await deleteR2Object(v.r2_key); } catch {}
      }
    }
    await deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE /api/review/projects/[id] error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
  }
}
