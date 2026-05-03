import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { isR2Configured, buildImageRefKey, getImagesUploadUrl, getImagesDownloadUrl, getImagesBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

/**
 * GET: list all image references on this project (newest first).
 * POST: presign an R2 upload to the images bucket and create a media_assets row.
 *   Body: { fileName, contentType, fileSize, name?, notes? }
 *   Returns: { uploadUrl, asset: { id, url, ... } }
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { rows } = await sql`
      SELECT id, name, url, r2_key, size_bytes, notes, metadata, created_at
      FROM media_assets
      WHERE project_id = ${id} AND type = 'image'
      ORDER BY created_at DESC
    `;
    // Refresh presigned URLs for R2-backed assets so they don't 404 after 24h
    const out = await Promise.all(rows.map(async r => {
      if (r.r2_key) {
        try { return { ...r, url: await getImagesDownloadUrl(r.r2_key) }; }
        catch { return r; }
      }
      return r;
    }));
    return NextResponse.json(out);
  } catch (err) {
    logger.error('GET image-refs error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    if (!isR2Configured()) {
      return NextResponse.json({
        error: 'Cloudflare R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_IMAGES_BUCKET_NAME.',
        code: 'R2_NOT_CONFIGURED',
      }, { status: 503 });
    }

    const { fileName, contentType, fileSize, name, notes } = await req.json();
    if (!fileName || !contentType) return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
    if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid image type: ${contentType}` }, { status: 400 });
    }
    if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Image too large (max 25MB)' }, { status: 400 });
    }

    const r2Key = buildImageRefKey(projectId, fileName);
    let uploadUrl: string;
    let downloadUrl: string;
    try {
      uploadUrl = await getImagesUploadUrl(r2Key, contentType);
      downloadUrl = await getImagesDownloadUrl(r2Key);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    // workspace_id is NOT NULL on media_assets since migration 0013 — copy
    // it from the parent project so this insert satisfies the constraint.
    const { rows } = await sql`
      INSERT INTO media_assets (project_id, type, source, name, url, r2_bucket, r2_key, size_bytes, notes, metadata, workspace_id)
      SELECT ${projectId}::uuid, 'image', 'upload', ${name || fileName},
             ${downloadUrl}, ${getImagesBucket()}, ${r2Key},
             ${typeof fileSize === 'number' ? fileSize : null},
             ${notes ?? null},
             ${JSON.stringify({ kind: 'image-ref', original_name: fileName })}::jsonb,
             p.workspace_id
        FROM projects p WHERE p.id = ${projectId}::uuid
      RETURNING id, name, url, r2_key, size_bytes, notes, created_at
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ uploadUrl, asset: rows[0] }, { status: 201 });
  } catch (err) {
    logger.error('POST image-refs error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to start upload: ${msg}` }, { status: 500 });
  }
}
