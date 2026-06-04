/**
 * POST /api/shorts/[id]/sync-duration
 *
 * One-click "make video length match the voiceover" + best-effort
 * "re-sync captions to actual word boundaries".
 *
 * Body: { seconds?: number }
 *
 * Strategy (after two failed attempts with ffmpeg + alignment-as-primary):
 *   1. Duration source — CLIENT-MEASURED. The editor reads
 *      `new Audio(url).duration` in the browser (the audio element
 *      that's already loaded knows the real length) and POSTs it.
 *      This bypasses every server-side flakiness we hit:
 *      - ffmpeg's stdin probe returning "Duration: N/A" on some MP3s
 *      - ElevenLabs Scribe failing on retry quotas / vendor 5xx
 *      The browser is the source of truth for what the user actually
 *      hears.
 *   2. Captions — BEST-EFFORT. Try to force-refresh the alignment so
 *      captions snap to the new word boundaries. If it fails, the
 *      duration still saves; the failure is reported back to the
 *      client so the toast can call out "duration synced, captions
 *      didn't" without blocking the user.
 *
 * If `seconds` isn't in the body (defensive — shouldn't happen from
 * the editor), the route falls back to running alignment for the
 * measurement, same as before.
 *
 * Workspace-scoped. 422 if there's no voiceover or the seconds value
 * is hostile.
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

/** Sanity bounds on the client-supplied seconds. A Short is between 5s
 *  and 90s in practice; the 0.5–600 range is generous defensive. */
function isReasonableSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 600;
}

export const POST = apiRoute.authed(
  async (session, req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: { seconds?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body is fine — the route falls back to alignment */
    }

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

      // Decide the duration source.
      let measuredSeconds: number | null = null;
      let durationSource: 'client' | 'alignment' = 'client';

      if (isReasonableSeconds(body.seconds)) {
        measuredSeconds = body.seconds;
        durationSource = 'client';
      } else if (body.seconds !== undefined) {
        // Caller sent something invalid — surface it loudly rather
        // than silently falling through to alignment.
        return NextResponse.json(
          {
            error:
              'Invalid `seconds` in the request body — must be a finite number between 0.5 and 600.',
          },
          { status: 422 },
        );
      }

      // Alignment refresh — best-effort. Wrap so a vendor 5xx / quota
      // hit doesn't fail the whole sync. We capture the result so the
      // toast can report what worked + what didn't.
      let alignment: import('@/lib/voiceover-alignment-cache').EnsureAlignmentResult | null = null;
      let alignmentError: string | null = null;
      if (row.short_script) {
        try {
          const canonical = buildCanonicalScript([
            shortAlignmentScript(row.short_script),
          ]);
          alignment = await ensureAlignmentForVoiceover(
            row.voiceover_audio_url,
            canonical,
            { forceRefresh: true },
          );
          if (alignment.status === 'failed') {
            alignmentError = alignment.reason;
            logger.warn('[shorts sync-duration] alignment failed (continuing)', {
              shortId: row.id,
              reason: alignment.reason,
            });
          } else if (measuredSeconds === null) {
            // Fallback path: no client measurement, use alignment.
            measuredSeconds = alignment.durationMs / 1000;
            durationSource = 'alignment';
          }
        } catch (err) {
          alignmentError = err instanceof Error ? err.message : String(err);
          logger.warn('[shorts sync-duration] alignment threw (continuing)', {
            shortId: row.id,
            detail: alignmentError,
          });
        }
      }

      // If we still have no duration, the client didn't send one AND
      // alignment failed. Surface the real reason.
      if (measuredSeconds === null) {
        return NextResponse.json(
          {
            error: alignmentError
              ? `Could not measure the voiceover. Alignment failed: ${alignmentError}. Try refreshing the page so the audio element re-loads, then click Sync again.`
              : 'Could not measure the voiceover. The audio element may not have loaded yet — wait a second and click Sync again.',
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
        source: durationSource,
        before_seconds: before,
        measured_seconds: measuredSeconds,
        alignment_status: alignment?.status ?? 'not-attempted',
        alignment_words:
          alignment?.status === 'ready' ? alignment.alignment.words.length : null,
      });

      return NextResponse.json({
        ok: true,
        source: durationSource,
        before_seconds: before,
        seconds: measuredSeconds,
        alignment:
          alignment?.status === 'ready' ? alignment.alignment : null,
        alignment_error: alignmentError,
      });
    } catch (err) {
      // Keep the catch as a defensive net but surface the actual
      // message so the user sees what's wrong instead of a generic 502.
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[shorts sync-duration] unexpected throw', {
        shortId: id,
        detail,
      });
      return domainErrorResponse(err, {
        op: 'shorts: sync voiceover duration',
        fallbackMessage: `Failed to sync the voiceover duration. ${detail.slice(0, 200)}`,
      });
    }
  },
);
