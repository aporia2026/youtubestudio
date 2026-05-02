import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteDipAnalysis, getDipAnalysis } from '@/lib/fix-the-dip';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const analysis = await getDipAnalysis(id, session.ws);
    if (!analysis) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ analysis });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteDipAnalysis(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
