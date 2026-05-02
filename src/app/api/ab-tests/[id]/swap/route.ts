import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { swapAbTestVariant } from '@/lib/ab-tests';
import { isAbTestVariant } from '@/lib/ab-tests-types';

export const maxDuration = 60;

/**
 * POST /api/ab-tests/[id]/swap
 *
 * Body: { toVariant: 'a' | 'b', skipThumbnail?: boolean }
 *
 * Pushes the selected variant live on YouTube (snippet + thumbnail). On a
 * draft test, the first /swap also flips status to 'running' and stamps
 * `started_at`. A snippet failure surfaces as 502 (YouTube refused); a
 * thumbnail failure is reported in the response body but does not roll
 * back the snippet update.
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
    const toVariant = b.toVariant;
    if (!isAbTestVariant(toVariant)) {
      return NextResponse.json({ error: 'toVariant must be "a" or "b"' }, { status: 400 });
    }
    const skipThumbnail = b.skipThumbnail === true;

    try {
      const result = await swapAbTestVariant({
        id,
        workspaceId: session.ws,
        toVariant,
        skipThumbnail,
      });
      return NextResponse.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found|not OAuth|already concluded|associated channel/.test(msg) ? 409 : 502;
      return NextResponse.json({ error: msg }, { status });
    }
  },
);
