import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getImagesDownloadUrl, getNarrationDownloadUrl, getDownloadPresignedUrl } from '@/lib/r2';

interface MediaRow {
  id: string;
  type: string;
  url: string | null;
  r2_key: string | null;
  r2_bucket: string | null;
  metadata: Record<string, unknown> | null;
  [key: string]: unknown;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`
      SELECT * FROM media_assets WHERE project_id = ${id} ORDER BY created_at DESC
    `;

    // Refresh presigned URLs for any R2-backed asset so playback / preview
    // doesn't break after the original 7-day TTL expires. Same pattern the
    // editor token route already uses on its read.
    const imagesBucket = process.env.R2_IMAGES_BUCKET_NAME || 'images';
    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const refreshed = await Promise.all((result.rows as MediaRow[]).map(async (r) => {
      if (!r.r2_key) return r;
      try {
        let url: string;
        if (r.r2_bucket === imagesBucket) {
          url = await getImagesDownloadUrl(r.r2_key);
        } else if (r.r2_bucket === narrationBucket) {
          url = await getNarrationDownloadUrl(r.r2_key);
        } else {
          url = await getDownloadPresignedUrl(r.r2_key);
        }
        return { ...r, url };
      } catch {
        return r;
      }
    }));

    return NextResponse.json({ assets: refreshed });
  } catch {
    return NextResponse.json({ assets: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const {
    type, source, name, url, blob_pathname, r2_bucket, r2_key,
    size_bytes, duration_seconds, notes, metadata,
  } = await req.json();

  if (!url || !type) return NextResponse.json({ error: 'url and type required' }, { status: 400 });

  try {
    // workspace_id is NOT NULL on media_assets since migration 0013 — copy
    // it from the parent project so this insert satisfies the constraint.
    // r2_bucket / r2_key are optional; populated when the asset lives in R2
    // so the GET handler can refresh the presigned URL on read.
    const result = await sql`
      INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, r2_bucket, r2_key, size_bytes, duration_seconds, notes, metadata, workspace_id)
      SELECT ${id}::uuid, ${type}, ${source || 'url'}, ${name || url.split('/').pop()},
             ${url}, ${blob_pathname || null},
             ${r2_bucket || null}, ${r2_key || null},
             ${size_bytes || 0}, ${duration_seconds || null},
             ${notes || ''}, ${JSON.stringify(metadata || {})}::jsonb,
             p.workspace_id
        FROM projects p WHERE p.id = ${id}::uuid
      RETURNING *
    `;
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;
    return NextResponse.json({ asset: result.rows[0] });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
