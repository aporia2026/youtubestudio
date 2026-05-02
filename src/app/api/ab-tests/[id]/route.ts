import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteAbTest,
  getAbTest,
  listAbTestSnapshots,
  summariseAbTestSnapshots,
} from '@/lib/ab-tests';

export const maxDuration = 30;

/**
 * GET /api/ab-tests/[id]
 *
 * Returns the test row, the full snapshot history (chronological), and an
 * aggregated per-variant summary (latest snapshot per variant wins —
 * Analytics totals are cumulative).
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const test = await getAbTest(id, session.ws);
    if (!test) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const snapshots = await listAbTestSnapshots(id, session.ws);
    const summary = summariseAbTestSnapshots(snapshots);
    return NextResponse.json({ test, snapshots, summary });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteAbTest(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
