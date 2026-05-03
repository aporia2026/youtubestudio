import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
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
      return domainErrorResponse(err, {
        op: 'ab-tests: snapshot',
        knownPatterns: [
          { match: /not found/i, status: 404 },
          { match: /not been started|associated channel|not OAuth/i, status: 409 },
        ],
        fallbackMessage: 'Could not record the AB test snapshot.',
      });
    }
  },
);
