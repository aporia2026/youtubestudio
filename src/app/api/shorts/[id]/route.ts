import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getShort, deleteShort } from '@/lib/shorts';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const short = await getShort(id, session.ws);
    if (!short) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ short });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteShort(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
