import { NextResponse } from 'next/server';
import { getTeamOverview } from '@/lib/team-db';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const overview = await getTeamOverview();
    return NextResponse.json(overview);
  } catch (err) {
    logger.error('GET team overview error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
