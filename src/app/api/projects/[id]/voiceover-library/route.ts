import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getNarrationDownloadUrl } from '@/lib/r2';

interface LibraryRow {
  id: string;
  project_id: string;
  project_title: string | null;
  name: string | null;
  url: string | null;
  r2_bucket: string | null;
  r2_key: string | null;
  blob_pathname: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * List existing voiceover assets across the current workspace so the user
 * can attach a previously-uploaded / narrator-approved voiceover to this
 * project (without re-uploading). Excludes the current project's own
 * voiceovers — those are already on the project's media tab.
 *
 * Refreshes presigned URLs for R2-backed rows on read so playback works
 * even after the original 7-day TTL expires.
 */
export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id: projectId } = await ctx.params;
  try {
    const { rows } = await sql<LibraryRow>`
      SELECT m.id, m.project_id, p.title AS project_title,
             m.name, m.url, m.r2_bucket, m.r2_key, m.blob_pathname,
             m.size_bytes, m.duration_seconds, m.metadata, m.created_at
      FROM media_assets m
      JOIN projects p ON p.id = m.project_id
      WHERE m.workspace_id = ${session.ws}::uuid
        AND m.type = 'voiceover'
        AND m.project_id <> ${projectId}::uuid
      ORDER BY m.created_at DESC
      LIMIT 200
    `;

    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const refreshed = await Promise.all(rows.map(async r => {
      if (r.r2_key && r.r2_bucket === narrationBucket) {
        try { return { ...r, url: await getNarrationDownloadUrl(r.r2_key) }; }
        catch { return r; }
      }
      return r;
    }));

    return NextResponse.json({ voiceovers: refreshed });
  } catch (err) {
    logger.error('GET voiceover-library error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ voiceovers: [] });
  }
});
