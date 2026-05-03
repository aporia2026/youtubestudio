import { NextRequest, NextResponse } from 'next/server';
import { updateNarratorProfile, deleteNarratorProfile } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    const profile = await updateNarratorProfile(id, fields);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(profile);
  } catch (err) {
    logger.error('PUT narrator profile error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteNarratorProfile(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE narrator profile error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete profile' }, { status: 500 });
  }
}
