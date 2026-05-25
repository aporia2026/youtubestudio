/**
 * GET /api/videos/[id]
 *
 * Returns the unified video context (channel, current stage, narrator,
 * editor, schedule slot, pipeline state, latest QA score) for the
 * VideoContextStrip and the Wave 2 Command Center cards.
 *
 * Auth: workspace-scoped. Returns 404 (not 403) for a video that exists
 * in another workspace, so the response shape never leaks the existence
 * of a foreign project to an unauthorised caller.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { requireUser, SessionError } from '@/lib/session';
import { loadVideoContext } from '@/lib/video-context';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const session = await requireUser();
    const video = await loadVideoContext(id, session.ws);
    if (!video) {
      logger.info('[api videos GET] not_found', { video_id: id });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    logger.info('[api videos GET] ok', {
      video_id: id,
      current_stage: video.current_stage,
      is_auto_managed: video.is_auto_managed,
    });
    return NextResponse.json({ video });
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('[api videos GET] fail', { detail: err instanceof Error ? err.message : String(err), video_id: id });
    return NextResponse.json({ error: 'Failed to load video' }, { status: 500 });
  }
}
