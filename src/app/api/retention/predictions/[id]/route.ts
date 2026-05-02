import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteRetentionPrediction, getRetentionPrediction } from '@/lib/retention-predictor';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const prediction = await getRetentionPrediction(id, session.ws);
    if (!prediction) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ prediction });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteRetentionPrediction(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
