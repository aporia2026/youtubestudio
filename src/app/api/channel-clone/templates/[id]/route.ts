/**
 * GET    /api/channel-clone/templates/[id]
 * DELETE /api/channel-clone/templates/[id]
 *
 * GET — Returns the FULL template config_jsonb plus signed-GET URLs
 *       for each reference video. The load flow uses the signed URLs
 *       to display thumbnails/durations + hand them to the intake-upload
 *       runner as already-uploaded video sources.
 *
 * DELETE — Soft-delete: stamps `deleted_at` on the row and queues R2
 *          cleanup in the background. The reap cron (out of scope for
 *          this commit) drops the SQL row + finalises R2 deletes 24h
 *          later. For the operator, the template disappears
 *          immediately.
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, type RouteContext } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  getChannelCloneTemplate,
  softDeleteChannelCloneTemplate,
} from '@/lib/channel-clone/templates-store';
import {
  deleteTemplateR2Keys,
  mintTemplateDownloadUrls,
} from '@/lib/channel-clone/templates-r2';

export const maxDuration = 30;

type Params = { id: string };

export const GET = apiRoute.authed(
  async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ error: 'template id is required' }, { status: 400 });
    const row = await getChannelCloneTemplate(id, session.ws);
    if (!row) return NextResponse.json({ error: 'template not found' }, { status: 404 });
    const downloads = await mintTemplateDownloadUrls(row.r2_keys);
    return NextResponse.json({
      template: {
        id: row.id,
        name: row.name,
        bytes: row.bytes,
        createdAt: row.created_at,
        sourceChannelUrl: row.config_jsonb.sourceChannelUrl,
        sourceChannelHandle: row.config_jsonb.sourceChannelHandle,
        sourceChannelName: row.config_jsonb.sourceChannelName,
        frameIntervalSec: row.config_jsonb.frameIntervalSec,
        clonedVoiceId: row.config_jsonb.clonedVoiceId,
        videos: row.config_jsonb.videos.map((v, i) => ({
          r2Key: v.r2Key,
          title: v.title,
          transcript: v.transcript,
          downloadUrl: downloads[i]?.url,
        })),
      },
    });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ error: 'template id is required' }, { status: 400 });
    const row = await getChannelCloneTemplate(id, session.ws);
    if (!row) return NextResponse.json({ error: 'template not found' }, { status: 404 });

    const flipped = await softDeleteChannelCloneTemplate(id, session.ws);
    if (!flipped) {
      // Race: the operator clicked delete twice. Idempotent — return 200.
      return NextResponse.json({ ok: true });
    }
    // Fire-and-forget R2 cleanup. Even if it fails individual keys
    // are recorded in the row's r2_keys manifest; the reap cron
    // (separate ticket) walks them at the 24h mark to finish the
    // job.
    void deleteTemplateR2Keys(row.r2_keys).catch((err) => {
      logger.warn('[channel-clone templates DELETE] background r2 cleanup failed', {
        templateId: id, error: err instanceof Error ? err.message : String(err),
      });
    });
    logger.info('[channel-clone templates DELETE] soft-deleted', {
      templateId: id, workspaceId: session.ws, r2KeyCount: row.r2_keys.length, bytes: row.bytes,
    });
    return NextResponse.json({ ok: true });
  },
);
