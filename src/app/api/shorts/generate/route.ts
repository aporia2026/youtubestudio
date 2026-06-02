import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { extractShortFromTranscriptMoment } from '@/lib/shorts';

/**
 * POST /api/shorts/generate
 *
 * Mode C — given a transcript moment from a YouTube video the user owns,
 * spin a brand-new `short_native` row via the existing extractor. The
 * resulting row plugs into the voiceover + render flow unchanged.
 *
 * Body:
 *   - youtubeVideoId: 11-char YouTube id (validated)
 *   - momentText:     the transcript text spanning the candidate window
 *   - clipStartMs:    integer ms
 *   - clipEndMs:      integer ms (must exceed clipStartMs)
 *   - projectId?:     workspace-scoped project to attach to
 *   - niche:          niche label for the extractor prompt
 *   - tone?:          freeform tone string
 *   - targetSeconds?: 10–90s, defaults to 45
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    youtubeVideoId?: string;
    momentText?: string;
    clipStartMs?: number;
    clipEndMs?: number;
    projectId?: string;
    niche?: string;
    tone?: string;
    targetSeconds?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // YouTube video id shape check.
  if (typeof body.youtubeVideoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(body.youtubeVideoId)) {
    return NextResponse.json({ error: 'Valid youtubeVideoId required' }, { status: 400 });
  }
  if (typeof body.momentText !== 'string' || body.momentText.trim().length < 30) {
    return NextResponse.json({ error: 'momentText must be at least 30 characters' }, { status: 400 });
  }
  if (
    typeof body.clipStartMs !== 'number'
    || typeof body.clipEndMs !== 'number'
    || !Number.isFinite(body.clipStartMs)
    || !Number.isFinite(body.clipEndMs)
    || body.clipStartMs < 0
    || body.clipEndMs <= body.clipStartMs
  ) {
    return NextResponse.json({ error: 'Valid clipStartMs/clipEndMs required' }, { status: 400 });
  }
  if (typeof body.niche !== 'string' || body.niche.trim().length === 0) {
    return NextResponse.json({ error: 'niche required' }, { status: 400 });
  }

  try {
    // Verify project ownership when supplied (no info-leak via 404).
    if (body.projectId) {
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM projects
         WHERE id = ${body.projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    const result = await extractShortFromTranscriptMoment({
      workspaceId: session.ws,
      projectId: body.projectId ?? null,
      sourceYoutubeVideoId: body.youtubeVideoId,
      momentText: body.momentText,
      clipStartMs: Math.round(body.clipStartMs),
      clipEndMs: Math.round(body.clipEndMs),
      niche: body.niche.trim(),
      tone: body.tone?.trim(),
      targetSeconds: body.targetSeconds,
    });

    logger.info('[shorts mode-c spin] done', {
      workspaceId: session.ws,
      shortId: result.id,
      sourceYoutubeVideoId: body.youtubeVideoId,
      clipStartMs: body.clipStartMs,
      clipEndMs: body.clipEndMs,
    });

    return NextResponse.json({ id: result.id, short: result.short });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: mode C spin',
      fallbackMessage: 'Failed to generate the Short from this moment.',
    });
  }
});
