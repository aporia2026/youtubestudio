import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { shortAlignmentScript } from '@/lib/shorts-render';
import {
  buildCanonicalScript,
  ensureAlignmentForVoiceover,
} from '@/lib/voiceover-alignment-cache';

/**
 * GET /api/shorts/[id]/alignment
 *
 * Phase 15.11 — returns the ElevenLabs forced-alignment payload for the
 * row's voiceover. First call populates the `voiceover_alignments` cache
 * (one Scribe call, ~$0.22/hr); subsequent calls are cache reads.
 *
 * The editor calls this after the row's voiceover URL lands so the
 * preview caption timing snaps to real word boundaries instead of
 * proportional-WPM estimates.
 *
 * Workspace-scoped via getShort; cross-tenant returns 404.
 */
export const maxDuration = 60;

export const GET = apiRoute.authed(
  async (session, req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // `?refresh=1` re-runs the aligner, bypassing the cache — backs the
    // editor's "Re-sync timing" button so a creator can force a fresh
    // alignment after editing the script.
    const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1';
    const row = await getShort(id, session.ws);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!row.voiceover_audio_url || !row.short_script) {
      return NextResponse.json(
        { error: 'Alignment needs both a voiceover URL and a script.' },
        { status: 422 },
      );
    }

    try {
      // Align on the SPOKEN text (markers stripped) so the aligner's word
      // stream matches the audio + the captions. Aligning on the raw script
      // desyncs from word zero. Same canonical build as the render route, so
      // both resolve the same cached alignment.
      const canonical = buildCanonicalScript([shortAlignmentScript(row.short_script)]);
      const result = await ensureAlignmentForVoiceover(row.voiceover_audio_url, canonical, { forceRefresh });
      if (result.status !== 'ready') {
        logger.warn('[shorts alignment] not ready', {
          shortId: row.id,
          status: result.status,
          reason: 'reason' in result ? result.reason : undefined,
        });
        return NextResponse.json(
          { error: 'reason' in result ? result.reason : 'Alignment failed' },
          { status: 502 },
        );
      }
      // Backfill `voiceover_duration_seconds` from the aligner's measured
      // duration (the alignment includes every word's start/end ms;
      // result.durationMs is the precise audio length). This heals existing
      // rows whose stored value was the old word-count estimate AND keeps
      // new rows accurate even if the ffmpeg probe in the voiceover route
      // fell back to the estimate for any reason. Only writes when the
      // alignment-derived value differs by more than 0.25s — avoids
      // dirtying the row on every read for already-correct durations.
      const measuredSeconds = result.durationMs / 1000;
      const storedSeconds = row.voiceover_duration_seconds ?? 0;
      if (Math.abs(measuredSeconds - storedSeconds) > 0.25) {
        await sql`
          UPDATE shorts
             SET voiceover_duration_seconds = ${measuredSeconds},
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;
        logger.info('[shorts alignment] backfilled voiceover_duration_seconds', {
          shortId: row.id,
          stored_before: storedSeconds,
          measured: measuredSeconds,
          delta_seconds: measuredSeconds - storedSeconds,
        });
      }

      logger.info('[shorts alignment] ok', {
        shortId: row.id,
        cached: result.cached,
        words: result.alignment.words.length,
      });
      return NextResponse.json({
        alignment: result.alignment,
        durationMs: result.durationMs,
        cached: result.cached,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: alignment',
        fallbackMessage: 'Failed to fetch alignment.',
      });
    }
  },
);
