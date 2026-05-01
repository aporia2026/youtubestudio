import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listAuditLog } from '@/lib/audit';

/**
 * GET /api/admin/audit-log?limit=&offset=&action=
 *
 * Read-only view of the admin audit log. Joins actor + target user emails
 * for human readability. Capped at 500 rows per request.
 */
export const GET = apiRoute.admin(async (_session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const offset = Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0;
  const action = searchParams.get('action') ?? undefined;
  const entries = await listAuditLog({ limit, offset, action: action || undefined });
  return NextResponse.json({ entries });
});
