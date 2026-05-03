import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  getAssignment,
  updateAssignment,
  getSectionsForAssignment,
  getCommentsForAssignment,
  resyncAssignmentSectionsIfStale,
  getTakeCommentCountsForAssignment,
} from '@/lib/narrator-db';
import { getNarrationDownloadUrl } from '@/lib/r2';

interface TakeRow { id: string; r2_key?: string | null; audio_url?: string | null; [key: string]: unknown }
interface SectionRow { id: string; takes?: TakeRow[] | null; [key: string]: unknown }

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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Lazy resync against the latest active script (no-op if unchanged or unsafe).
    await resyncAssignmentSectionsIfStale(id);
    const sections = await getSectionsForAssignment(id);
    const comments = await getCommentsForAssignment(id);
    const sectionsWithFreshUrls = await refreshTakeUrls(sections as SectionRow[]);

    // Embed per-take comment counts so the owner's NarrationTab can show
    // unresolved badges next to each Review button without N extra fetches.
    const takeCounts = await getTakeCommentCountsForAssignment(id);
    const sectionsWithCounts = sectionsWithFreshUrls.map(section => ({
      ...section,
      takes: section.takes
        ? section.takes.map((t: TakeRow) => ({
            ...t,
            ...(takeCounts[t.id] || { comment_count: 0, unresolved_count: 0, has_owner_feedback: false, has_unresolved_owner_feedback: false }),
          }))
        : section.takes,
    }));

    const a = assignment as { full_audio_r2_key?: string | null; full_audio_url?: string | null; full_audio_take_id?: string | null; [key: string]: unknown };
    if (a.full_audio_r2_key) {
      try { a.full_audio_url = await getNarrationDownloadUrl(a.full_audio_r2_key); } catch {}
    }
    if (a.full_audio_take_id && takeCounts[a.full_audio_take_id]) {
      Object.assign(a, {
        full_audio_comment_count: takeCounts[a.full_audio_take_id].comment_count,
        full_audio_unresolved_count: takeCounts[a.full_audio_take_id].unresolved_count,
        full_audio_has_unresolved_owner_feedback: takeCounts[a.full_audio_take_id].has_unresolved_owner_feedback,
      });
    }

    return NextResponse.json({ assignment, sections: sectionsWithCounts, comments });
  } catch (err) {
    logger.error('GET assignment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to get assignment' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    const assignment = await updateAssignment(id, fields);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(assignment);
  } catch (err) {
    logger.error('PUT assignment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update assignment' }, { status: 500 });
  }
}
