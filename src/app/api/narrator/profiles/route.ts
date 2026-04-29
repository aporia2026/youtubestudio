import { NextRequest, NextResponse } from 'next/server';
import { createNarratorProfile, listNarratorProfiles } from '@/lib/narrator-db';

export async function GET() {
  try {
    const profiles = await listNarratorProfiles();
    return NextResponse.json(profiles);
  } catch (err) {
    console.error('GET narrator profiles error:', err);
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
    console.error('POST narrator profile error:', err);
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 });
  }
}
