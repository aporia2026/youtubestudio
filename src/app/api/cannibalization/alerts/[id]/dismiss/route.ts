import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { dismissCannibalizationAlert } from '@/lib/cannibalization';

/**
 * POST /api/cannibalization/alerts/[id]/dismiss
 *
 * Marks the alert dismissed (status='dismissed') so subsequent scans
 * don't re-flag the same pair. The row is preserved as historical
 * record — we don't hard-delete dismissed alerts.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await dismissCannibalizationAlert(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found or already dismissed' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
