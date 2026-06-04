/**
 * POST /api/shorts/[id]/sync-duration
 *
 * Re-probe the actual voiceover audio length and write it to
 * `shorts.voiceover_duration_seconds`. The render path + preview Player
 * both read from that column, so updating it makes the composition the
 * exact length of the audio — no padded tail, no estimate drift.
 *
 * Why this exists as an explicit button:
 *   - The voiceover route already probes on generation (see
 *     `audio-duration-probe.ts`).
 *   - The alignment route already backfills when timing data lands.
 *   - But back-catalog rows whose stored value is the old word-count
 *     estimate (and that haven't had a re-alignment pass since) need a
 *     manual lever the user can pull right before render. That's this
 *     route.
 *
 * Workspace-scoped (404 on cross-tenant). Returns the new duration so
 * the editor can toast confirmation without a separate row reload.
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { probeAudioDurationSeconds } from '@/lib/audio-duration-probe';

export const maxDuration = 30;

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

      // Fetch the audio bytes from R2. Public URL by construction, so
      // no auth header needed.
      const res = await fetch(row.voiceover_audio_url);
      if (!res.ok) {
        throw new Error(
          `Voiceover audio fetch failed (HTTP ${res.status}). The R2 URL may have expired or been deleted.`,
        );
      }
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      const measuredSeconds = await probeAudioDurationSeconds(audioBuffer);

      if (measuredSeconds === null) {
        return NextResponse.json(
          {
            error:
              'Could not measure the voiceover audio. ffmpeg returned no Duration line — the file may be corrupt or in an unexpected format.',
          },
          { status: 502 },
        );
      }

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
      });

      return NextResponse.json({
        ok: true,
        before_seconds: before,
        seconds: measuredSeconds,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: sync voiceover duration',
        fallbackMessage: 'Failed to sync the voiceover duration.',
      });
    }
  },
);
