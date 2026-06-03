import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { runShortsAssetTickForShort } from '@/lib/shorts-asset-cron';

/**
 * POST /api/shorts/[id]/run-asset-tick
 *
 * Client-driven driver for style-asset generation (Phase 15.16). The editor
 * calls this on its poll loop while a job is in flight, so the work advances
 * — and resumes after a request death — even on preview / local deploys where
 * Vercel crons don't run. Each call advances the Short by one bounded tick
 * (plan / base / a batch of variants) and returns; the editor calls again
 * until the job finalizes. Workspace-scoped via the runner; single-flight
 * locked so it never collides with the cron or the enqueue drain.
 *
 * maxDuration matches the runner's tick budget headroom.
 */
export const maxDuration = 300;

export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const outcome = await runShortsAssetTickForShort(id, session.ws);
      if (!outcome.ran) {
        // Another runner holds the lock — that's fine, it's doing the work.
        return NextResponse.json({ ran: false, reason: 'busy' });
      }
      return NextResponse.json({ ran: true, ...outcome.result });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: run asset tick',
        fallbackMessage: 'Failed to advance asset generation.',
      });
    }
  },
);
