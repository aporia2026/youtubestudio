import { NextRequest, NextResponse } from 'next/server';
import { createShareLink, getShareLinks, deleteShareLink, getProject } from '@/lib/review-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const links = await getShareLinks(id);
    return NextResponse.json(links);
  } catch (err) {
    console.error('GET share links error:', err);
    return NextResponse.json({ error: 'Failed to get share links' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const { permission, expiresAt, collaboratorId, label } = await req.json();
    const perm = permission || 'can-comment';
    if (!['view-only', 'can-comment', 'can-annotate'].includes(perm)) {
      return NextResponse.json({ error: 'Invalid permission. Must be: view-only, can-comment, or can-annotate' }, { status: 400 });
    }
    const link = await createShareLink(id, perm, expiresAt, collaboratorId, label);
    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    console.error('POST share link error:', err);
    return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { linkId } = await req.json();
    if (!linkId) return NextResponse.json({ error: 'linkId required' }, { status: 400 });
    await deleteShareLink(linkId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE share link error:', err);
    return NextResponse.json({ error: 'Failed to delete share link' }, { status: 500 });
  }
}
