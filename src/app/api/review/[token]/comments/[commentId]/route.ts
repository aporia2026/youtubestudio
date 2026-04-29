import { NextRequest, NextResponse } from 'next/server';

/**
 * Public/token-based comment mutation is disabled.
 * Only the owner can resolve/unresolve comments — see the owner-side
 * endpoint at /api/review/projects/[id]/comments/[commentId].
 */
export async function PATCH(_req: NextRequest) {
  return NextResponse.json(
    { error: 'Only the project owner can resolve comments.' },
    { status: 403 },
  );
}
