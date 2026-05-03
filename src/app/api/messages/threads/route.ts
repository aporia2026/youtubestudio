import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceOwner, listThreadsForOwner } from '@/lib/messages-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Owner-side: list every thread the owner has (sorted by last activity)
 * plus every collaborator without a thread yet so the owner can initiate.
 *
 * Auth: matches the existing wide-open owner-route pattern. Phase 1
 * `withWorkspace` retrofit will gate this to the session user.
 */
export async function GET(_req: NextRequest) {
  try {
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ error: 'No workspace owner configured' }, { status: 503 });
    const threads = await listThreadsForOwner(owner.id);
    return NextResponse.json({ owner: { id: owner.id, name: owner.name, color: owner.color }, threads });
  } catch (err) {
    logger.error('GET threads error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to load threads' }, { status: 500 });
  }
}
