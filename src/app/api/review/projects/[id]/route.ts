import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject, deleteProject, getVersions } from '@/lib/review-db';
import { deleteR2Object } from '@/lib/r2';
import { notifyStatusChanged } from '@/lib/notify';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const versions = await getVersions(id);
    return NextResponse.json({ project, versions });
  } catch (err) {
    console.error('GET /api/review/projects/[id] error:', err);
    return NextResponse.json({ error: 'Failed to get project' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    // Capture old status for change detection
    const before = await getProject(id);
    const project = await updateProject(id, fields);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Fire-and-forget: notify collaborators if status actually changed
    if (before && fields.status && before.status !== project.status) {
      notifyStatusChanged({
        projectId: id,
        projectTitle: project.title,
        oldStatus: before.status,
        newStatus: project.status,
      }).catch(e => console.error('notifyStatusChanged failed:', e));
    }

    return NextResponse.json(project);
  } catch (err) {
    console.error('PATCH /api/review/projects/[id] error:', err);
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Clean up R2 objects for all versions
    const versions = await getVersions(id);
    for (const v of versions) {
      if (v.r2_key) {
        try { await deleteR2Object(v.r2_key); } catch {}
      }
    }
    await deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/review/projects/[id] error:', err);
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
  }
}
