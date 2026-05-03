import { NextRequest, NextResponse } from 'next/server';
import { createProject, listProjects, createShareLink } from '@/lib/review-db';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json(projects);
  } catch (err) {
    logger.error('GET /api/review/projects error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to list projects' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { title, description } = await req.json();
    if (!title?.trim()) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    const project = await createProject(title.trim(), description?.trim());
    // Auto-create a default share link
    const shareLink = await createShareLink(project.id, 'can-comment');
    return NextResponse.json({ project, shareLink }, { status: 201 });
  } catch (err) {
    logger.error('POST /api/review/projects error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
