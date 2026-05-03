import { NextRequest, NextResponse } from 'next/server';
import { revokeAllAccess } from '@/lib/team-db';
import { logger } from '@/lib/logger';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await revokeAllAccess(id);
    return NextResponse.json(result);
  } catch (err) {
    logger.error('revoke-all error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to revoke access' }, { status: 500 });
  }
}
