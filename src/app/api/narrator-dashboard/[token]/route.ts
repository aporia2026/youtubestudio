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
        -- Filter out section 0 — the synthetic holder for full-script
        -- single-file uploads. It would otherwise sit permanently 'pending'
        -- and inflate every count by 1 on assignments that used the full
        -- upload path.
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.section_number != 0) AS total_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.section_number != 0 AND s.status = 'approved') AS approved_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.section_number != 0 AND s.status = 'submitted') AS submitted_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.section_number != 0 AND s.status = 'retake') AS retake_sections,
        (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.section_number != 0 AND s.status = 'pending') AS pending_sections,
        (SELECT COUNT(*)::int FROM narrator_comments c WHERE c.assignment_id = a.id AND c.author_role = 'owner' AND c.created_at > a.last_accessed_at) AS unread_owner_comments,
        -- Per-take Frame.io-style feedback that the narrator hasn't
        -- resolved yet. Drives the "feedback waiting" badge on the
        -- assignment card so the narrator sees the call-to-action
        -- without opening the assignment.
        (
          SELECT COUNT(*)::int
          FROM narration_take_comments tc
          JOIN narrator_takes t ON t.id = tc.take_id
          JOIN narrator_sections s ON s.id = t.section_id
          WHERE s.assignment_id = a.id
            AND tc.author_role = 'owner'
            AND tc.parent_id IS NULL
            AND tc.resolved = false
        ) AS unresolved_owner_take_comments
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

    // Compute spoken word counts per assignment. SUM of words across all
    // sections AFTER stripping bracketed cues (production directions like
    // [VISUAL CUE: ...] and performance tags like [excited] alike — neither
    // is actually spoken). Done in JS so the regex stays in sync with the
    // teleprompter's stripCues helper. Single query, then map.
    const assignmentIds = assignments.map(a => a.id as string);
    const wordCounts = new Map<string, number>();
    if (assignmentIds.length > 0) {
      const { rows: sections } = await sql.query<{ assignment_id: string; script_text: string }>(
        // Filter out section 0 (full-audio holder) — its empty script_text
        // would zero-out a sum but it's still cheaper not to fetch it.
        `SELECT assignment_id, script_text FROM narrator_sections WHERE assignment_id = ANY($1::uuid[]) AND section_number != 0`,
        [assignmentIds],
      );
      for (const sec of sections) {
        const spoken = (sec.script_text || '').replace(/\[[^\]]+\]/g, '');
        const words = spoken.split(/\s+/).filter(w => w.length > 0).length;
        wordCounts.set(sec.assignment_id, (wordCounts.get(sec.assignment_id) || 0) + words);
      }
    }
    const enriched = assignments.map(a => ({ ...a, total_words: wordCounts.get(a.id as string) || 0 }));

    return NextResponse.json({
      narrator: {
        id: narrator.id,
        name: narrator.name,
        email: narrator.email,
        color: narrator.color,
      },
      assignments: enriched,
    });
  } catch (err) {
    console.error('GET narrator dashboard error:', err);
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
