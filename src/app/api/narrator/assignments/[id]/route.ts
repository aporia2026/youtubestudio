import { NextRequest, NextResponse } from 'next/server';
import { getAssignment, updateAssignment, getSectionsForAssignment, getCommentsForAssignment } from '@/lib/narrator-db';
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
    const sections = await getSectionsForAssignment(id);
    const comments = await getCommentsForAssignment(id);
    const sectionsWithFreshUrls = await refreshTakeUrls(sections as SectionRow[]);
    return NextResponse.json({ assignment, sections: sectionsWithFreshUrls, comments });
  } catch (err) {
    console.error('GET assignment error:', err);
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
    console.error('PUT assignment error:', err);
    return NextResponse.json({ error: 'Failed to update assignment' }, { status: 500 });
  }
}
