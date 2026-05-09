/**
 * GET /api/team-hub/takes/[takeId]
 *
 * Hydrates the right-pane Take surface with everything <TakeReview /> needs
 * in one round-trip: fresh signed audio URL, the section's script text,
 * the take's own metadata, and the narrator's identity.
 *
 * Workspace gate: the underlying narrator_takes row chains take →
 * narrator_sections → narrator_assignments, and narrator_assignments
 * carries workspace_id (NOT NULL since migration 0013). The query joins
 * through the chain and filters on `workspace_id = session.ws` so a
 * forged take id from another workspace cannot leak.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getNarrationDownloadUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TakeRow {
  take_id: string;
  audio_url: string;
  r2_key: string | null;
  duration_seconds: number | null;
  script_text: string;
  section_label: string | null;
  section_number: number;
  assignment_id: string;
  narrator_name: string | null;
  narrator_color: string | null;
}

export const GET = apiRoute.authed<{ takeId: string }>(async (session, _req, ctx) => {
  const { takeId } = await ctx.params;
  if (!UUID_RE.test(takeId)) {
    return NextResponse.json({ error: 'Invalid take id' }, { status: 400 });
  }
  try {
    const { rows } = await sql<TakeRow>`
      SELECT
        t.id AS take_id,
        t.audio_url,
        t.r2_key,
        t.duration_seconds,
        s.script_text,
        s.label AS section_label,
        s.section_number,
        a.id AS assignment_id,
        c.name AS narrator_name,
        c.color AS narrator_color
        FROM narrator_takes t
        JOIN narrator_sections s ON s.id = t.section_id
        JOIN narrator_assignments a ON a.id = s.assignment_id
        LEFT JOIN collaborators c ON c.id = a.narrator_id
       WHERE t.id = ${takeId}
         AND a.workspace_id = ${session.ws}
       LIMIT 1
    `;
    const row = rows[0];
    // 404 (not 403) so existence isn't leaked across workspaces.
    if (!row) return NextResponse.json({ error: 'Take not found' }, { status: 404 });

    // Re-presign the R2 URL on every read so the client always gets a
    // fresh, valid signed URL even if the cached audio_url has expired.
    let audio_url = row.audio_url;
    if (row.r2_key) {
      try {
        audio_url = await getNarrationDownloadUrl(row.r2_key);
      } catch (err) {
        logger.warn('team-hub takes: r2 presign failed', {
          detail: err instanceof Error ? err.message : String(err),
          take_id: takeId,
        });
      }
    }

    return NextResponse.json({
      take: {
        id: row.take_id,
        audio_url,
        duration_ms: row.duration_seconds != null ? Math.round(row.duration_seconds * 1000) : null,
      },
      section: {
        label: row.section_label,
        number: row.section_number,
        script_text: row.script_text,
      },
      assignment: { id: row.assignment_id },
      narrator: {
        name: row.narrator_name ?? 'Narrator',
        color: row.narrator_color ?? '#7c3aed',
      },
    });
  } catch (err) {
    logger.error('GET /api/team-hub/takes/[takeId]', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      take_id: takeId,
    });
    return NextResponse.json({ error: 'Failed to load take' }, { status: 500 });
  }
});
