import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { triageComments } from '@/lib/comment-triage';

// AI loop runs CONCURRENCY=3 in parallel — worst case ~10s for 25
// comments with Haiku. 60s ceiling is comfortable.
export const maxDuration = 180;

/**
 * POST /api/comments/triage
 *
 * Body: {
 *   videoId?: string,           — limit to one video
 *   limit?: number,              — how many comments to classify (default 25, max 100)
 *   reclassify?: boolean,        — true = re-run on already-classified comments
 *   modelId?: string,            — defaults to claude-haiku-4-5
 *   contextual?: { videoTitle?, channelName?, niche? } — optional context for better suggested replies
 * }
 *
 * Runs AI intent classification on unclassified comments, persists
 * intent + suggested_reply onto each row, returns per-comment summaries.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown = {};
  try {
    if (req.body) body = await req.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const ctx = (b.contextual && typeof b.contextual === 'object' ? b.contextual : {}) as Record<string, unknown>;

  try {
    const result = await triageComments({
      workspaceId: session.ws,
      videoId: typeof b.videoId === 'string' && b.videoId ? b.videoId : undefined,
      limit:
        typeof b.limit === 'number' && Number.isFinite(b.limit)
          ? Math.max(1, Math.min(100, Math.round(b.limit)))
          : undefined,
      reclassify: b.reclassify === true,
      modelId: typeof b.modelId === 'string' && b.modelId ? b.modelId : undefined,
      contextual: {
        videoTitle: typeof ctx.videoTitle === 'string' ? ctx.videoTitle : undefined,
        channelName: typeof ctx.channelName === 'string' ? ctx.channelName : undefined,
        niche: typeof ctx.niche === 'string' ? ctx.niche : undefined,
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'comments: triage',
      fallbackMessage: 'Could not triage comments — please try again.',
    });
  }
});
