import { NextResponse } from 'next/server';
import { getTeamOverview } from '@/lib/team-db';

export async function GET() {
  try {
    const overview = await getTeamOverview();
    return NextResponse.json(overview);
  } catch (err) {
    console.error('GET team overview error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
