import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { recordAbTestSnapshot } from '@/lib/ab-tests';

export const maxDuration = 60;

/**
 * POST /api/ab-tests/[id]/snapshot
 *
 * Pulls fresh analytics for the test's underlying YouTube video, tags the
 * row with whichever variant is currently live, and appends a row to
 * `ab_test_snapshots`. Returns the inserted snapshot.
 *
 * Errors out with 409 when the test is still in 'draft' (no variant has
 * been pushed live yet) or when the channel isn't OAuth-connected.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const snapshot = await recordAbTestSnapshot({ id, workspaceId: session.ws });
      return NextResponse.json({ snapshot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found|not been started|associated channel|not OAuth/.test(msg) ? 409 : 502;
      return NextResponse.json({ error: msg }, { status });
    }
  },
);
