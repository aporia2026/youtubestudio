import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteAskStudioQuestion, getAskStudioQuestion } from '@/lib/ask-studio';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const question = await getAskStudioQuestion(id, session.ws);
    if (!question) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ question });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteAskStudioQuestion(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
