/**
 * POST /api/videos/[id]/advance
 *
 * Body: { toStage: VideoStageId, source?: AdvanceSource, note?: string }
 *
 * Funnels every manual stage transition through advanceVideo(), the
 * single seam that records to video_stage_transitions and respects the
 * auto-pipeline's gating logic. Refuses with a 409 (Conflict) + the
 * gate's human-readable reason when an auto-managed video can't be
 * advanced manually.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { requireUser, SessionError } from '@/lib/session';
import { advanceVideo, type AdvanceSource } from '@/lib/advance-video';
import { isVideoStageId, type VideoStageId } from '@/lib/video-stages';

const ALLOWED_SOURCES: readonly AdvanceSource[] = [
  'strip-next',
  'strip-prev',
  'kanban-drag',
  'manual-api',
] as const;

const BodySchema = z.object({
  toStage: z.string().refine(isVideoStageId, 'Invalid stage id'),
  source: z.enum(ALLOWED_SOURCES as readonly [AdvanceSource, ...AdvanceSource[]]).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const session = await requireUser();
    const json = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid body', detail: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await advanceVideo({
      videoId: id,
      toStage: parsed.data.toStage as VideoStageId,
      source: parsed.data.source ?? 'manual-api',
      workspaceId: session.ws,
      actorUserId: session.uid,
      actorLabel: null,
      note: parsed.data.note ?? null,
    });

    if (!result.ok) {
      const status = result.code === 'not_found'
        ? 404
        : result.code === 'forbidden'
          ? 403
          : result.code === 'gated'
            ? 409
            : 400;
      return NextResponse.json({ error: result.reason, code: result.code }, { status });
    }

    return NextResponse.json({ ok: true, transitionId: result.transitionId, fromStage: result.fromStage, toStage: result.toStage });
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('[api videos advance POST] fail', { detail: err instanceof Error ? err.message : String(err), video_id: id });
    return NextResponse.json({ error: 'Failed to advance video' }, { status: 500 });
  }
}
