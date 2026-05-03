import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, createVersion } from '@/lib/review-db';
import { isR2Configured, buildR2Key, getUploadPresignedUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/x-msvideo', 'video/x-matroska'];

/**
 * Editor uploads a corrected version directly from the review page.
 *
 * Mirrors /api/editor/[token]/projects/[projectId]/upload-video but auths
 * via a review SHARE token rather than the editor's personal_token. This
 * way the review page never has to expose the personal_token to the
 * client (see the security note on the review GET route).
 *
 * Only allowed when the share link's collaborator carries the `editor`
 * role. Reviewers/clients/narrators can't upload finished videos.
 *
 * Two-step presigned upload (matches the rest of the upload paths):
 *   POST { fileName, contentType, fileSize? } → { uploadUrl, versionId, ... }
 *   PATCH { versionId, thumbnail_url?, duration_ms?, width?, height? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    if (!link.collaborator_id) {
      return NextResponse.json({ error: 'Anonymous links cannot upload' }, { status: 403 });
    }
    const { rows: collabRows } = await sql`
      SELECT id, name, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
    `;
    const collab = collabRows[0];
    if (!collab) return NextResponse.json({ error: 'Collaborator not found' }, { status: 403 });
    const allRoles: string[] = Array.isArray(collab.roles) && collab.roles.length > 0
      ? collab.roles
      : (collab.role ? [collab.role] : []);
    if (!allRoles.includes('editor')) {
      return NextResponse.json({ error: 'Only editors can upload corrected versions' }, { status: 403 });
    }

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' }, { status: 503 });
    }

    const { fileName, contentType, fileSize } = await req.json();
    if (!fileName || !contentType) return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
    if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid video type: ${contentType}` }, { status: 400 });
    }

    // Reserve a new review_version directly on the share link's review project.
    const version = await createVersion(
      link.project_id,
      '',
      collab.name || 'editor',
      typeof fileSize === 'number' ? fileSize : undefined,
    );
    const r2Key = buildR2Key(link.project_id, version.version_number, fileName);

    let uploadUrl: string;
    try {
      uploadUrl = await getUploadPresignedUrl(r2Key, contentType);
      await sql`UPDATE review_versions SET r2_key = ${r2Key} WHERE id = ${version.id}`;
    } catch (e) {
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
    logger.error('share-token upload-video error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to start upload: ${msg}` }, { status: 500 });
  }
}

/** PATCH: confirm video metadata after R2 upload completes. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    const { versionId, thumbnail_url, duration_ms, width, height } = await req.json();
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });

    const { rows } = await sql`
      SELECT id FROM review_versions WHERE id = ${versionId} AND project_id = ${link.project_id} LIMIT 1
    `;
    if (rows.length === 0) return NextResponse.json({ error: 'Version not found' }, { status: 403 });

    await sql`
      UPDATE review_versions SET
        thumbnail_url = COALESCE(${thumbnail_url ?? null}, thumbnail_url),
        duration_ms = COALESCE(${typeof duration_ms === 'number' ? duration_ms : null}, duration_ms),
        width = COALESCE(${typeof width === 'number' ? width : null}, width),
        height = COALESCE(${typeof height === 'number' ? height : null}, height)
      WHERE id = ${versionId}
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('PATCH share-token video error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
