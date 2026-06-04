/**
 * POST /api/shorts/[id]/sync-duration
 *
 * One-click "make video length match the voiceover" + "re-sync captions
 * to actual word boundaries". Does both because they're driven by the
 * same underlying measurement.
 *
 * Implementation:
 *   1. Force-refreshes the ElevenLabs Scribe alignment for the voiceover.
 *      That call returns word-perfect timing AND the audio's precise
 *      length — much more reliable than ffmpeg-probing the mp3 (which
 *      has been flaky on the Vercel function bundle: ffmpeg sometimes
 *      doesn't print a Duration line when reading certain MP3 streams
 *      from stdin).
 *   2. Writes the aligner's durationMs to `voiceover_duration_seconds`.
 *      The render path + the preview Player both read that column, so
 *      the composition now matches the audio exactly.
 *   3. Returns the new duration AND the alignment so the editor can
 *      apply it without a second roundtrip.
 *
 * Why this exists as an explicit button:
 *   - The aligner runs automatically once per voiceover load to backfill
 *     timing. But back-catalog rows whose cached alignment is stale
 *     (script edited, voiceover regenerated, etc.) need a manual lever
 *     to re-measure right before render. That's this route.
 *
 * Workspace-scoped. 422 if no voiceover; 502 if the aligner fails.
 */
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

export const maxDuration = 60;

export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const row = await getShort(id, session.ws);
      if (!row) {
        return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      }
      if (!row.voiceover_audio_url) {
        return NextResponse.json(
          { error: 'Generate the voiceover first.' },
          { status: 422 },
        );
      }
      if (!row.short_script) {
        return NextResponse.json(
          { error: 'This Short has no script to align against.' },
          { status: 422 },
        );
      }

      // Force-refresh the aligner. Bypasses the cache so a stale row
      // (script edited after the cached alignment was minted, voiceover
      // regenerated, etc.) re-measures from scratch. ~$0.22/hr to
      // ElevenLabs Scribe; pennies per Short.
      const canonical = buildCanonicalScript([shortAlignmentScript(row.short_script)]);
      const result = await ensureAlignmentForVoiceover(
        row.voiceover_audio_url,
        canonical,
        { forceRefresh: true },
      );

      if (result.status !== 'ready') {
        return NextResponse.json(
          {
            error: `Alignment failed — ${'reason' in result ? result.reason : 'unknown'}.`,
          },
          { status: 502 },
        );
      }

      const measuredSeconds = result.durationMs / 1000;
      const before = row.voiceover_duration_seconds ?? null;
      await sql`
        UPDATE shorts
           SET voiceover_duration_seconds = ${measuredSeconds},
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;
      logger.info('[shorts sync-duration] updated', {
        shortId: row.id,
        before_seconds: before,
        measured_seconds: measuredSeconds,
        delta_seconds: before === null ? null : measuredSeconds - before,
        words: result.alignment.words.length,
      });

      return NextResponse.json({
        ok: true,
        before_seconds: before,
        seconds: measuredSeconds,
        // Return the fresh alignment so the editor can apply it without
        // a second GET /alignment roundtrip — saves a re-fetch and means
        // the captions snap to the new boundaries in the same click.
        alignment: result.alignment,
        durationMs: result.durationMs,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: sync voiceover duration',
        fallbackMessage: 'Failed to sync the voiceover duration.',
      });
    }
  },
);
