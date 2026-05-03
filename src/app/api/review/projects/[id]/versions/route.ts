import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createVersion, getProject, updateVersion } from '@/lib/review-db';
import { buildR2Key, getUploadPresignedUrl } from '@/lib/r2';
import { notifyVersionUploaded } from '@/lib/notify';
import { logger } from '@/lib/logger';

/** POST: Generate a presigned upload URL and create a version row. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const project = await getProject(projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const { fileName, contentType, fileSize } = await req.json();
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName and contentType are required' }, { status: 400 });
    }

    // Validate content type is a video format
    const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/x-msvideo', 'video/x-matroska'];
    if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid video type: ${contentType}. Allowed: ${ALLOWED_VIDEO_TYPES.join(', ')}` }, { status: 400 });
    }

    // Verify R2 is configured before creating any DB rows — fail fast with a
    // clear setup message if env vars are missing.
    if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
      return NextResponse.json({
        error: 'Cloudflare R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME in your environment.',
        code: 'R2_NOT_CONFIGURED',
      }, { status: 503 });
    }

    // Create version row first to get version_number
    const version = await createVersion(projectId, '', 'owner', fileSize);
    const r2Key = buildR2Key(projectId, version.version_number, fileName);

    // Update the version row with the real r2_key
    await sql`UPDATE review_versions SET r2_key = ${r2Key} WHERE id = ${version.id}`;

    let uploadUrl: string;
    try {
      uploadUrl = await getUploadPresignedUrl(r2Key, contentType);
    } catch (e) {
      // Roll back the version row if presigning fails
      await sql`DELETE FROM review_versions WHERE id = ${version.id}`;
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    return NextResponse.json({
      uploadUrl,
      versionId: version.id,
      versionNumber: version.version_number,
      r2Key,
    }, { status: 201 });
  } catch (err) {
    logger.error('POST /api/review/projects/[id]/versions error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to create version: ${msg}` }, { status: 500 });
  }
}

/** PATCH: Update version metadata (thumbnail, duration, dimensions) after upload completes. */
export async function PATCH(req: NextRequest) {
  try {
    const { versionId, thumbnail_url, duration_ms, width, height } = await req.json();
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });
    const version = await updateVersion(versionId, { thumbnail_url, duration_ms, width, height });

    // Fire-and-forget: notify all collaborators that a new version is ready
    if (version) {
      sql`SELECT title FROM review_projects WHERE id = ${version.project_id}`
        .then(r => {
          const title = r.rows[0]?.title;
          if (!title) return;
          notifyVersionUploaded({
            projectId: version.project_id,
            projectTitle: title,
            versionId: version.id,
            versionNumber: version.version_number,
          }).catch(e => logger.error('notifyVersionUploaded failed', { detail: e instanceof Error ? e.message : String(e) }));
        }).catch(() => {});
    }

    return NextResponse.json(version);
  } catch (err) {
    logger.error('PATCH versions error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update version' }, { status: 500 });
  }
}
