import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sendTestWebhook } from '@/lib/webhooks';

export const maxDuration = 30;

/**
 * POST /api/webhooks/subscriptions/[id]/test
 *
 * Sends a synthetic "test" event to the named subscription. Bypasses
 * event_filters so the user always gets the test message regardless
 * of which events they've subscribed to.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const result = await sendTestWebhook(id, session.ws);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  },
);
