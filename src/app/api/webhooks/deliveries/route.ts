import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listWebhookDeliveries } from '@/lib/webhooks';

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const subscriptionId = searchParams.get('subscriptionId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const deliveries = await listWebhookDeliveries(session.ws, { subscriptionId, limit });
  return NextResponse.json({ deliveries });
});
