import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken, getSectionsForAssignment, getCommentsForAssignment, resyncAssignmentSectionsIfStale } from '@/lib/narrator-db';
import { getNarrationDownloadUrl } from '@/lib/r2';

interface TakeRow {
  id: string;
  r2_key?: string | null;
  audio_url?: string | null;
  [key: string]: unknown;
}

interface SectionRow {
  id: string;
  takes?: TakeRow[] | null;
  [key: string]: unknown;
}

/** Regenerate fresh presigned URLs for R2-backed takes (presigned URLs expire). */
async function refreshTakeUrls(sections: SectionRow[]): Promise<SectionRow[]> {
  return Promise.all(sections.map(async (section) => {
    if (!section.takes) return section;
    const takes = await Promise.all(section.takes.map(async (t: TakeRow) => {
      if (t.r2_key) {
        try { return { ...t, audio_url: await getNarrationDownloadUrl(t.r2_key) }; } catch { return t; }
      }
      return t;
    }));
    return { ...section, takes };
  }));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    // Track access (fire-and-forget)
    sql`UPDATE narrator_assignments SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE share_token = ${token}`.catch(() => {});

    // Lazy resync: if the project's active script is newer than what the
    // assignment was last built from AND no takes exist yet, rebuild the
    // sections so the narrator sees the latest script. Belt-and-braces with
    // the script-POST hook that does the same on save — this guarantees
    // freshness even when the save happened before the feature shipped.
    await resyncAssignmentSectionsIfStale(assignment.id);

    const sections = await getSectionsForAssignment(assignment.id);
    const comments = await getCommentsForAssignment(assignment.id);
    const sectionsWithFreshUrls = await refreshTakeUrls(sections as SectionRow[]);

    // Refresh the full-audio presigned URL so the player doesn't fail mid-session.
    const a = assignment as { full_audio_r2_key?: string | null; full_audio_url?: string | null; [key: string]: unknown };
    if (a.full_audio_r2_key) {
      try { a.full_audio_url = await getNarrationDownloadUrl(a.full_audio_r2_key); } catch {}
    }

    return NextResponse.json({ assignment, sections: sectionsWithFreshUrls, comments });
  } catch (err) {
    console.error('GET narrate/[token] error:', err);
    return NextResponse.json({ error: 'Failed to load assignment' }, { status: 500 });
  }
}
