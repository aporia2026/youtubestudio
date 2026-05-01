import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceOwner, getUnreadCountForUser } from '@/lib/messages-db';

export const runtime = 'nodejs';

/** Owner-side: total unread count for the nav badge. */
export async function GET(_req: NextRequest) {
  try {
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ unread: 0 });
    const n = await getUnreadCountForUser(owner.id);
    return NextResponse.json({ unread: n });
  } catch (err) {
    console.error('GET owner unread error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
