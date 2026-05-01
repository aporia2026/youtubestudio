import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { bumpEditorAssignmentAccess, getEditorAssignment } from '@/lib/editor-db';
import { getImagesDownloadUrl } from '@/lib/r2';
import { getDownloadPresignedUrl } from '@/lib/r2';

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

    // Refresh presigned URLs on R2-backed assets. Decide which bucket-aware
    // presigner to use based on the stored r2_bucket — images vs videos.
    const imagesBucket = process.env.R2_IMAGES_BUCKET_NAME || 'images';
    const refreshed = await Promise.all((mediaRows as MediaRow[]).map(async (r) => {
      if (!r.r2_key) return r;
      try {
        const isImages = r.r2_bucket === imagesBucket;
        const url = isImages ? await getImagesDownloadUrl(r.r2_key) : await getDownloadPresignedUrl(r.r2_key);
        return { ...r, url };
      } catch { return r; }
    }));

    const imageRefs = refreshed.filter(m => m.type === 'image' && m.metadata?.kind !== 'thumbnail');
    const thumbnails = refreshed.filter(m => m.type === 'image' && m.metadata?.kind === 'thumbnail');
    const voiceovers = refreshed.filter(m => m.type === 'voiceover');
    const videos = refreshed.filter(m => m.type === 'video');

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
          await sql`
            INSERT INTO review_share_links (project_id, token, permission, collaborator_id, label)
            VALUES (${reviewProjectId}, ${newToken}, 'can-comment', ${editor.id}, 'Editor auto-link')
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
      ytRefs,
      reviewProjectId,
      reviewVersions,
      reviewShareToken,
    });
  } catch (err) {
    console.error('GET editor project error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
