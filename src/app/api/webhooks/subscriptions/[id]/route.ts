import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteWebhookSubscription, updateWebhookSubscription } from '@/lib/webhooks';

export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const ok = await updateWebhookSubscription({
      id,
      workspaceId: session.ws,
      label: typeof b.label === 'string' ? b.label : undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      eventFilters: Array.isArray(b.eventFilters)
        ? b.eventFilters.filter((s): s is string => typeof s === 'string')
        : undefined,
    });
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteWebhookSubscription(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
