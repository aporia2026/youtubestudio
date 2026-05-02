import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { concludeAbTest } from '@/lib/ab-tests';
import { isAbTestVariant } from '@/lib/ab-tests-types';

export const maxDuration = 60;

/**
 * POST /api/ab-tests/[id]/conclude
 *
 * Body: { winner: 'a' | 'b', pushWinnerLive?: boolean }
 *
 * Pushes the winning variant live (when not already), then flips the test
 * to 'concluded'. After conclusion, /swap is rejected; the test row is
 * preserved as the historical record of the experiment.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const winner = b.winner;
    if (!isAbTestVariant(winner)) {
      return NextResponse.json({ error: 'winner must be "a" or "b"' }, { status: 400 });
    }
    const pushWinnerLive = b.pushWinnerLive !== false;

    try {
      const test = await concludeAbTest({
        id,
        workspaceId: session.ws,
        winner,
        pushWinnerLive,
      });
      return NextResponse.json({ test });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /already concluded|not found|associated channel|not OAuth/.test(msg) ? 409 : 502;
      return NextResponse.json({ error: msg }, { status });
    }
  },
);
