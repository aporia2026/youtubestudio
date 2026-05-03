import { NextRequest, NextResponse } from 'next/server';
import { createNarratorProfile, listNarratorProfiles } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const profiles = await listNarratorProfiles();
    return NextResponse.json(profiles);
  } catch (err) {
    logger.error('GET narrator profiles error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to list profiles' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    const profile = await createNarratorProfile({ ...body, name: body.name.trim() });
    return NextResponse.json(profile, { status: 201 });
  } catch (err) {
    logger.error('POST narrator profile error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 });
  }
}
