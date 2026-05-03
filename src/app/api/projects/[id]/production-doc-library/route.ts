import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getImagesDownloadUrl } from '@/lib/r2';

interface LibraryRow {
  id: string;
  project_id: string;
  project_title: string | null;
  name: string | null;
  url: string | null;
  source: string | null;
  r2_bucket: string | null;
  r2_key: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * List existing production_doc assets across the current workspace so the
 * owner can attach a previously-uploaded doc (PDF / DOCX / Sheet link)
 * to this project's editor assignment without re-uploading. Excludes the
 * current project's own docs.
 *
 * Refreshes the presigned download URL for any R2-backed asset on read so
 * the picker preview / download link doesn't hit a 403 once the original
 * 7-day TTL expires.
 */
export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id: projectId } = await ctx.params;
  try {
    const { rows } = await sql<LibraryRow>`
      SELECT m.id, m.project_id, p.title AS project_title,
             m.name, m.url, m.source, m.r2_bucket, m.r2_key,
             m.size_bytes, m.metadata, m.created_at
      FROM media_assets m
      JOIN projects p ON p.id = m.project_id
      WHERE m.workspace_id = ${session.ws}::uuid
        AND m.type = 'production_doc'
        AND m.project_id <> ${projectId}::uuid
      ORDER BY m.created_at DESC
      LIMIT 200
    `;

    const imagesBucket = process.env.R2_IMAGES_BUCKET_NAME || 'images';
    const refreshed = await Promise.all(rows.map(async r => {
      if (r.r2_key && r.r2_bucket === imagesBucket) {
        try { return { ...r, url: await getImagesDownloadUrl(r.r2_key) }; }
        catch { return r; }
      }
      return r;
    }));

    return NextResponse.json({ docs: refreshed });
  } catch (err) {
    logger.error('GET production-doc-library error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ docs: [] });
  }
});
