import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getNarratorByPersonalToken } from '@/lib/team-db';

/**
 * Public API for the narrator's personal dashboard at /narrator/[token].
 * Returns the narrator's profile + every assignment they've been given,
 * with section progress counts so the dashboard can show a queue.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const narrator = await getNarratorByPersonalToken(token);
    if (!narrator) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const { rows: assignments } = await sql`
      SELECT
        a.id,
        a.status,
        a.deadline,
        a.share_token,
        a.director_notes,
        a.created_at,
        a.updated_at,
        p.title AS project_title,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id) AS total_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.status = 'approved') AS approved_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.status = 'submitted') AS submitted_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.status = 'retake') AS retake_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.status = 'pending') AS pending_sections,
        (SELECT COUNT(*)::int FROM narrator_comments c WHERE c.assignment_id = a.id AND c.author_role = 'owner' AND c.created_at > a.last_accessed_at) AS unread_owner_comments
      FROM narrator_assignments a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.narrator_id = ${narrator.id}
      ORDER BY
        CASE a.status
          WHEN 'revisions' THEN 1
          WHEN 'recording' THEN 2
          WHEN 'received' THEN 3
          WHEN 'assigned' THEN 4
          WHEN 'submitted' THEN 5
          WHEN 'approved' THEN 6
          WHEN 'completed' THEN 7
          ELSE 8
        END,
        a.deadline ASC NULLS LAST,
        a.updated_at DESC
    `;

    return NextResponse.json({
      narrator: {
        id: narrator.id,
        name: narrator.name,
        email: narrator.email,
        color: narrator.color,
      },
      assignments,
    });
  } catch (err) {
    console.error('GET narrator dashboard error:', err);
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
