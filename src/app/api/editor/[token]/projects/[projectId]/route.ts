import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { bumpEditorAssignmentAccess, getEditorAssignment } from '@/lib/editor-db';
import { getImagesDownloadUrl, getNarrationDownloadUrl, getDownloadPresignedUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

interface MediaRow {
  id: string;
  type: string;
  url: string | null;
  r2_key: string | null;
  r2_bucket: string | null;
  metadata: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Returns everything the editor needs for one project they're assigned to:
 * project metadata, latest script, image references, thumbnails, voiceover,
 * YouTube references, and any existing review versions (so they can see what
 * was previously uploaded for review and the comments on it).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string; projectId: string }> }) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment) return NextResponse.json({ error: 'Not assigned to this project' }, { status: 403 });

    bumpEditorAssignmentAccess(projectId, editor.id);

    // Project basics
    const { rows: projectRows } = await sql`
      SELECT id, title, niche, topic, status FROM projects WHERE id = ${projectId} LIMIT 1
    `;
    const project = projectRows[0];
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // Latest active script
    const { rows: scriptRows } = await sql`
      SELECT id, version, content, word_count, estimated_duration_seconds, created_at
      FROM scripts WHERE project_id = ${projectId} AND is_active = true
      ORDER BY version DESC LIMIT 1
    `;
    const script = scriptRows[0] || null;

    // All media — split into image refs / thumbnails / voiceover / video
    const { rows: mediaRows } = await sql`
      SELECT id, type, source, name, url, r2_bucket, r2_key, size_bytes, duration_seconds, notes, metadata, created_at
      FROM media_assets WHERE project_id = ${projectId}
      ORDER BY created_at DESC
    `;

    // Refresh presigned URLs on R2-backed assets. Three buckets in play —
    // images, narration, review/videos — pick the matching presigner based
    // on the stored r2_bucket.
    //
    // Narrator-approved voiceovers from earlier builds were inserted with
    // r2_key/r2_bucket left NULL on the column and the values tucked into
    // metadata. Fall back to those so existing rows heal themselves on read
    // instead of serving an expired presign that 404s for the editor.
    const imagesBucket = process.env.R2_IMAGES_BUCKET_NAME || 'images';
    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const refreshed = await Promise.all((mediaRows as MediaRow[]).map(async (r) => {
      const meta = r.metadata || {};
      const r2Key = r.r2_key || (typeof meta.r2_key === 'string' ? meta.r2_key as string : null);
      // Narrator full-narration rows are tagged in metadata; treat them as
      // narration-bucket even if the bucket column wasn't populated.
      const r2Bucket = r.r2_bucket || (meta.full_narration === true ? narrationBucket : null);
      if (!r2Key) return r;
      try {
        let url: string;
        if (r2Bucket === imagesBucket) {
          url = await getImagesDownloadUrl(r2Key);
        } else if (r2Bucket === narrationBucket) {
          url = await getNarrationDownloadUrl(r2Key);
        } else {
          url = await getDownloadPresignedUrl(r2Key);
        }
        return { ...r, url };
      } catch { return r; }
    }));

    const imageRefs = refreshed.filter(m => m.type === 'image' && m.metadata?.kind !== 'thumbnail');
    const thumbnails = refreshed.filter(m => m.type === 'image' && m.metadata?.kind === 'thumbnail');
    const voiceovers = refreshed.filter(m => m.type === 'voiceover');
    const videos = refreshed.filter(m => m.type === 'video');
    const productionDocs = refreshed.filter(
      m => m.type === 'document' && m.metadata?.kind === 'production_doc',
    );

    // YouTube refs
    const { rows: ytRefs } = await sql`
      SELECT id, youtube_url, video_id, title, channel, duration, thumbnail_url, notes
      FROM youtube_references WHERE project_id = ${projectId}
      ORDER BY created_at DESC
    `;

    // Existing review versions (if a review project is linked) + latest comments count
    let reviewVersions: Array<{ id: string; version_number: number; thumbnail_url: string | null; duration_ms: number | null; created_at: string; comment_count: number }> = [];
    const reviewProjectId: string | null = assignment.review_project_id || null;
    let reviewShareToken: string | null = null;
    if (reviewProjectId) {
      const { rows } = await sql`
        SELECT v.id, v.version_number, v.thumbnail_url, v.duration_ms, v.created_at,
          (SELECT COUNT(*)::int FROM review_comments c WHERE c.version_id = v.id AND c.resolved = false) AS comment_count
        FROM review_versions v
        WHERE v.project_id = ${reviewProjectId}
        ORDER BY v.version_number DESC
      `;
      reviewVersions = rows as typeof reviewVersions;

      // Find or auto-create a review share link tied to this editor on this
      // review project. Without one, the editor has no path to the actual
      // review UI (player + comments + resolve). Permission `can-comment`
      // gives them full feedback abilities without drawing tools.
      try {
        const { rows: linkRows } = await sql`
          SELECT token FROM review_share_links
          WHERE project_id = ${reviewProjectId} AND collaborator_id = ${editor.id}
          ORDER BY created_at DESC
          LIMIT 1
        `;
        if (linkRows[0]?.token) {
          reviewShareToken = linkRows[0].token as string;
        } else {
          const newToken = crypto.randomUUID();
          // workspace_id is NOT NULL on review_share_links since migration
          // 0013 — copy it from the parent review_project so this auto-create
          // doesn't fail the same way createShareLink used to.
          await sql`
            INSERT INTO review_share_links (project_id, token, permission, collaborator_id, label, workspace_id)
            SELECT ${reviewProjectId}::uuid, ${newToken}, 'can-comment', ${editor.id}::uuid, 'Editor auto-link', rp.workspace_id
              FROM review_projects rp WHERE rp.id = ${reviewProjectId}::uuid
          `;
          reviewShareToken = newToken;
        }
      } catch (e) {
        console.warn('auto-create editor share link failed:', e);
      }
    }

    return NextResponse.json({
      editor: { id: editor.id, name: editor.name, color: editor.color },
      project,
      assignment,
      script,
      imageRefs,
      thumbnails,
      voiceovers,
      videos,
      productionDocs,
      ytRefs,
      reviewProjectId,
      reviewVersions,
      reviewShareToken,
    });
  } catch (err) {
    logger.error('GET editor project error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
