import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

interface LibraryRow {
  id: string;
  project_id: string | null;
  project_title: string | null;
  name: string | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  narrator_id: string | null;
  narrator_name: string | null;
  assignment_id: string | null;
  schedule_item_id: string | null;
}

export interface VoiceoverLibraryEntry {
  id: string;
  audioUrl: string;
  name: string;
  narratorName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  assignmentId: string | null;
  scheduleItemId: string | null;
  durationSeconds: number | null;
  timestamp: number;
  source: 'narrator_full' | 'narrator_stitched' | 'other';
}

/**
 * Workspace-wide list of `media_assets` voiceovers — covers both
 * narrator-approved single-file uploads (metadata.full_narration) and
 * stitched section assemblies (metadata.stitched). The production-doc
 * voiceover picker merges this with the user's ElevenLabs history so
 * narrator-recorded takes show up alongside Voiceover Studio output.
 *
 * Picker-side matching wants assignment_id → schedule_item_id, so we
 * resolve the schedule-item linkage here via the JSONB custom_fields
 * pointer that's stamped on schedule_items when an assignment is created.
 *
 * `audioUrl` is always the same-origin proxy `/api/voiceovers/[id]/audio`,
 * never the raw R2 / Blob URL. Routing through the proxy is what makes
 * Remotion's `<Audio>` happy: the player fetches bytes for decoding and
 * needs CORS-clean, presign-stable URLs that don't 403 mid-playback.
 * The proxy 302's to Vercel Blob for non-R2 rows so we don't waste a hop
 * on storage that already has permissive CORS.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const { rows } = await sql<LibraryRow>`
      SELECT m.id, m.project_id, p.title AS project_title,
             m.name, m.duration_seconds, m.metadata, m.created_at,
             a.narrator_id, c.name AS narrator_name,
             (m.metadata->>'assignment_id') AS assignment_id,
             si.id AS schedule_item_id
      FROM media_assets m
      LEFT JOIN projects p ON p.id = m.project_id
      LEFT JOIN narrator_assignments a
        ON a.id = CASE
          WHEN m.metadata->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (m.metadata->>'assignment_id')::uuid
          ELSE NULL
        END
      LEFT JOIN collaborators c ON c.id = a.narrator_id
      LEFT JOIN LATERAL (
        SELECT id FROM schedule_items
        WHERE custom_fields->>'narrator_assignment_id' = (m.metadata->>'assignment_id')
        LIMIT 1
      ) si ON true
      WHERE m.workspace_id = ${session.ws}::uuid
        AND m.type = 'voiceover'
      ORDER BY m.created_at DESC
      LIMIT 200
    `;

    const entries: VoiceoverLibraryEntry[] = rows.map((r): VoiceoverLibraryEntry => {
      const meta = r.metadata || {};
      const source: VoiceoverLibraryEntry['source'] =
        meta.stitched === true ? 'narrator_stitched'
        : meta.full_narration === true ? 'narrator_full'
        : 'other';
      return {
        id: r.id,
        audioUrl: `/api/voiceovers/${r.id}/audio`,
        name: r.name || 'Voiceover',
        narratorName: r.narrator_name,
        projectId: r.project_id,
        projectTitle: r.project_title,
        assignmentId: r.assignment_id,
        scheduleItemId: r.schedule_item_id,
        durationSeconds: r.duration_seconds,
        timestamp: new Date(r.created_at).getTime(),
        source,
      };
    });

    return NextResponse.json({ voiceovers: entries });
  } catch (err) {
    logger.error('GET voiceovers/library error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ voiceovers: [] });
  }
});
