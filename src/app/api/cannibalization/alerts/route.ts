import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listCannibalizationAlerts } from '@/lib/cannibalization';

/**
 * GET /api/cannibalization/alerts?status=active|dismissed&limit=
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get('status');
  const status: 'active' | 'dismissed' | undefined =
    statusParam === 'active' || statusParam === 'dismissed' ? statusParam : undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100;
  const alerts = await listCannibalizationAlerts(session.ws, { status, limit });
  return NextResponse.json({ alerts });
});
