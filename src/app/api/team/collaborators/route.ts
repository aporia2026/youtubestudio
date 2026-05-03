import { NextRequest, NextResponse } from 'next/server';
import { createCollaborator, listCollaborators } from '@/lib/team-db';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const role = req.nextUrl.searchParams.get('role') || undefined;
    const collaborators = await listCollaborators(role);
    return NextResponse.json(collaborators);
  } catch (err) {
    logger.error('GET collaborators error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to list collaborators' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    const collaborator = await createCollaborator({ ...body, name: body.name.trim() });
    return NextResponse.json(collaborator, { status: 201 });
  } catch (err) {
    logger.error('POST collaborator error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create collaborator' }, { status: 500 });
  }
}
