import { NextRequest, NextResponse } from 'next/server';
import { createCollaborator, listCollaborators } from '@/lib/team-db';

export async function GET(req: NextRequest) {
  try {
    const role = req.nextUrl.searchParams.get('role') || undefined;
    const collaborators = await listCollaborators(role);
    return NextResponse.json(collaborators);
  } catch (err) {
    console.error('GET collaborators error:', err);
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
    console.error('POST collaborator error:', err);
    return NextResponse.json({ error: 'Failed to create collaborator' }, { status: 500 });
  }
}
