import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { fetchTranscript } from '@/lib/youtube-transcript';
import { scoreClips, type ClipScorerSegment } from '@/lib/clip-scorer';
import { getShortsSettings } from '@/lib/shorts-workspace-settings-db';

/**
 * POST /api/shorts/find-clips
 * Body: { youtubeVideoId: string, projectId?: string, persist?: boolean }
 *
 * Mode A explicit invocation. Given a YouTube video id, fetches the
 * transcript, scores candidate Short moments via the deterministic
 * clip-scorer, and (when persist=true) writes them to the `shorts`
 * table as `kind='channel_clip_recommendation'`, `medium='short_clip'`.
 *
 * The persist flag lets the UI preview candidates without committing
 * them to the inbox; clicking "save" runs the same endpoint with
 * persist=true.
 *
 * Workspace scoping: the projectId (if supplied) is verified to belong
 * to the session workspace before any DB write — returns 404 on miss
 * (no info leak).
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: { youtubeVideoId?: string; projectId?: string; persist?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { youtubeVideoId, projectId } = body;
  const persist = body.persist === true;

  // Basic id-shape guard — YouTube video ids are 11 base64url chars.
  if (typeof youtubeVideoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) {
    return NextResponse.json({ error: 'Valid youtubeVideoId required' }, { status: 400 });
  }
  if (projectId !== undefined && typeof projectId !== 'string') {
    return NextResponse.json({ error: 'projectId must be a string' }, { status: 400 });
  }

  try {
    // Verify project ownership BEFORE any external API call so the
    // 404 path doesn't burn the transcript fetch budget.
    if (projectId) {
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM projects
         WHERE id = ${projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    const settings = await getShortsSettings(session.ws);

    const transcript = await fetchTranscript(youtubeVideoId);
    if (!transcript || transcript.segments.length === 0) {
      logger.info('[shorts mode-a transcript]', {
        workspaceId: session.ws,
        youtubeVideoId,
        result: 'empty',
      });
      return NextResponse.json(
        { error: 'No transcript available for this video.', candidates: [] },
        { status: 422 },
      );
    }

    logger.info('[shorts mode-a transcript]', {
      workspaceId: session.ws,
      youtubeVideoId,
      segments: transcript.segments.length,
      durationSeconds: transcript.durationSeconds,
    });

    const segments: ClipScorerSegment[] = transcript.segments.map((s) => ({
      text: s.text,
      offset_ms: s.offset,
      duration_ms: s.duration,
    }));

    const candidates = scoreClips(segments, {
      topN: 5,
      targetSeconds: settings.defaultTargetSecondsModeA,
    });

    logger.info('[shorts mode-a score]', {
      workspaceId: session.ws,
      youtubeVideoId,
      candidateCount: candidates.length,
      topScore: candidates[0]?.score ?? null,
    });

    if (!persist || candidates.length === 0) {
      return NextResponse.json({ candidates, persisted: 0 });
    }

    // Persist as channel_clip_recommendation rows. One DB statement per
    // candidate — they're independent and we want partial-success on
    // single-row failure.
    let persisted = 0;
    for (const c of candidates) {
      try {
        const firstSentence = c.text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? c.text;
        const lastSentence =
          c.text.split(/(?<=[.!?])\s+/).slice(-1)[0]?.trim() ?? c.text;
        await sql`
          INSERT INTO shorts (
            workspace_id, project_id,
            kind, medium,
            title, hook, payoff,
            word_count, estimated_duration_seconds,
            hook_score,
            source_youtube_video_id, clip_start_ms, clip_end_ms
          ) VALUES (
            ${session.ws}::uuid,
            ${projectId ?? null}::uuid,
            'channel_clip_recommendation',
            'short_clip',
            ${null},
            ${firstSentence},
            ${lastSentence},
            ${c.wordCount},
            ${Math.round(c.durationSeconds)},
            ${c.hookScore},
            ${youtubeVideoId},
            ${c.startMs},
            ${c.endMs}
          )
        `;
        persisted++;
      } catch (err) {
        logger.warn('[shorts mode-a persist] candidate insert failed', {
          workspaceId: session.ws,
          youtubeVideoId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({ candidates, persisted });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: find clips',
      fallbackMessage: 'Failed to find clips for this video.',
    });
  }
});
