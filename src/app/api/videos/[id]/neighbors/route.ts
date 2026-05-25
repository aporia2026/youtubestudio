/**
 * GET /api/videos/[id]/neighbors
 *
 * Returns the previous and next stage in the canonical STAGE_CHAIN with
 * URLs that preserve `?videoId=` so the user keeps context through
 * navigation. Used by the VideoContextStrip's Prev/Next buttons.
 *
 * Split from /api/videos/[id] so the strip can cheaply re-fetch
 * neighbors when the page hash changes (e.g. after an advance) without
 * pulling the full context blob again.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { requireUser, SessionError } from '@/lib/session';
import { loadVideoContext, neighborUrlsForStage } from '@/lib/video-context';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const session = await requireUser();
    const video = await loadVideoContext(id, session.ws);
    if (!video) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const neighbors = neighborUrlsForStage(video.current_stage, video.id);
    logger.info('[api videos neighbors GET] ok', {
      video_id: id,
      current_stage: video.current_stage,
      has_prev: neighbors.prev !== null,
      has_next: neighbors.next !== null,
    });
    return NextResponse.json({
      current_stage: video.current_stage,
      current_stage_label: video.current_stage_label,
      current_stage_index: video.current_stage_index,
      neighbors,
    });
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('[api videos neighbors GET] fail', { detail: err instanceof Error ? err.message : String(err), video_id: id });
    return NextResponse.json({ error: 'Failed to load neighbors' }, { status: 500 });
  }
}
