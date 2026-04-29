import { NextRequest, NextResponse } from 'next/server';
import { updateNarratorProfile, deleteNarratorProfile } from '@/lib/narrator-db';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    const profile = await updateNarratorProfile(id, fields);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(profile);
  } catch (err) {
    console.error('PUT narrator profile error:', err);
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteNarratorProfile(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE narrator profile error:', err);
    return NextResponse.json({ error: 'Failed to delete profile' }, { status: 500 });
  }
}
