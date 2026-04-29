import { NextRequest, NextResponse } from 'next/server';
import { revokeAllAccess } from '@/lib/team-db';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await revokeAllAccess(id);
    return NextResponse.json(result);
  } catch (err) {
    console.error('revoke-all error:', err);
    return NextResponse.json({ error: 'Failed to revoke access' }, { status: 500 });
  }
}
