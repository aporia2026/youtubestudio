import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { createWebhookSubscription, listWebhookSubscriptions } from '@/lib/webhooks';
import type { WebhookKind } from '@/lib/webhooks-types';

export const GET = apiRoute.authed(async (session) => {
  const subscriptions = await listWebhookSubscriptions(session.ws);
  return NextResponse.json({ subscriptions });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const kindRaw = b.kind;
  const kind: WebhookKind =
    kindRaw === 'slack' || kindRaw === 'discord' || kindRaw === 'generic' ? kindRaw : 'slack';
  const label = typeof b.label === 'string' ? b.label : '';
  const webhookUrl = typeof b.webhookUrl === 'string' ? b.webhookUrl : '';
  const eventFilters = Array.isArray(b.eventFilters) ? b.eventFilters.filter((s): s is string => typeof s === 'string') : [];

  if (!webhookUrl) return NextResponse.json({ error: 'webhookUrl is required' }, { status: 400 });

  try {
    const result = await createWebhookSubscription({
      workspaceId: session.ws,
      collaboratorId: session.uid,
      kind,
      label,
      webhookUrl,
      eventFilters,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'webhooks: create',
      knownPatterns: [
        { match: /required|invalid url|must be|unsupported/i, status: 400 },
      ],
      fallbackMessage: 'Could not create the webhook subscription.',
    });
  }
});
