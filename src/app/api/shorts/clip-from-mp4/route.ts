import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { resolveAndPinSafeUrl } from '@/lib/url-safety';
import {
  buildClipOutputKey,
  runCenterCrop916,
  validateClipRange,
  CLIP_DEFAULT_TIMEOUT_MS,
} from '@/lib/shorts-clip-from-mp4';
import {
  getDownloadUrlForBucket,
  getReviewBucket,
  uploadToBucket,
} from '@/lib/r2';

/**
 * POST /api/shorts/clip-from-mp4 — Phase 15.7 Mode B v1-lite.
 *
 * Body:
 *   - source_url:     required, https URL to the MP4 to clip
 *   - start_seconds:  required, non-negative number
 *   - end_seconds:    required, > start_seconds, duration 3-90s
 *   - projectId?:     optional workspace-scoped project to attach to
 *   - notes?:         optional free-text notes saved on the row
 *
 * Returns: { id, rendered_video_url } once the clip is on R2.
 *
 * Honest limitations (surface to the user in the UI):
 *   - Dumb center-crop only; subjects on the sides get chopped.
 *   - No auto-caption — burn captions in YouTube Studio.
 *   - Vercel function 300s budget; long sources risk timeout.
 *   - Source URL is fetched via Vercel function egress; very large
 *     files burn function-time + bandwidth budget.
 *
 * Maximum function duration is the route default (configurable per
 * environment). The clip orchestrator imposes a 270s cap internally
 * to leave room for upload + DB write within the function budget.
 */
export const maxDuration = 300;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    source_url?: unknown;
    start_seconds?: unknown;
    end_seconds?: unknown;
    projectId?: unknown;
    notes?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.source_url !== 'string' || !/^https?:\/\//i.test(body.source_url)) {
    return NextResponse.json({ error: 'source_url required (https URL)' }, { status: 400 });
  }
  const rangeError = validateClipRange(body.start_seconds, body.end_seconds);
  if (rangeError) {
    return NextResponse.json({ error: rangeError }, { status: 400 });
  }
  const startSec = body.start_seconds as number;
  const endSec = body.end_seconds as number;
  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim().length > 0
      ? body.projectId.trim()
      : null;
  const notes =
    typeof body.notes === 'string' && body.notes.trim().length > 0
      ? body.notes.trim().slice(0, 1000)
      : null;

  try {
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

    // SSRF defence: resolve + pin the source URL so a redirect to a
    // private address can't be smuggled in between validation and fetch.
    // Reuses the helper that publishing + webhooks already use.
    let safeUrl: string;
    try {
      const pinned = await resolveAndPinSafeUrl(body.source_url as string);
      safeUrl = pinned.url.toString();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Source URL rejected by safety check: ${detail}` },
        { status: 400 },
      );
    }

    // Use a per-request temp filename. Cleaned up below in finally.
    const tmpPath = path.join(os.tmpdir(), `shorts-clip-${randomUUID()}.mp4`);
    let clipMeta;
    try {
      clipMeta = await runCenterCrop916({
        sourceUrl: safeUrl,
        startSec,
        endSec,
        outputPath: tmpPath,
        timeoutMs: CLIP_DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[shorts mode-b clip] ffmpeg failed', { detail, sourceUrl: body.source_url });
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    // Read + upload to R2.
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(clipMeta.outputPath);
    const r2Key = buildClipOutputKey(session.ws);
    await uploadToBucket(getReviewBucket(), r2Key, buf, 'video/mp4');
    const renderedUrl = await getDownloadUrlForBucket(
      getReviewBucket(),
      r2Key,
      process.env.R2_PUBLIC_URL,
    );

    // Best-effort cleanup; failures here don't fail the request.
    try {
      await fs.unlink(clipMeta.outputPath);
    } catch {
      /* ignore */
    }

    // Persist as a short_clip row — semantically this IS a clip from
    // a source video; rendered_video_url carries the cropped output.
    const { rows } = await sql<{ id: string }>`
      INSERT INTO shorts (
        workspace_id, project_id,
        kind, medium,
        title, notes,
        word_count, estimated_duration_seconds,
        clip_start_ms, clip_end_ms,
        rendered_video_url,
        generation_params
      ) VALUES (
        ${session.ws}::uuid,
        ${projectId ?? null}::uuid,
        'channel_clip_recommendation',
        'short_clip',
        ${null},
        ${notes},
        ${null},
        ${Math.round(clipMeta.durationSec)},
        ${Math.round(startSec * 1000)},
        ${Math.round(endSec * 1000)},
        ${renderedUrl},
        ${JSON.stringify({
          mode_b: 'v1-lite',
          source_url: body.source_url,
          source_url_host: safeUrl,
          byte_length: clipMeta.byteLength,
          ffmpeg_filter: 'center-crop-9-16-dumb',
        })}::jsonb
      )
      RETURNING id
    `;

    const id = rows[0]!.id;
    logger.info('[shorts mode-b clip] persisted', {
      workspaceId: session.ws,
      shortId: id,
      r2Key,
      byteLength: clipMeta.byteLength,
      durationSec: clipMeta.durationSec,
    });

    return NextResponse.json({ id, rendered_video_url: renderedUrl, byte_length: clipMeta.byteLength });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: clip from mp4',
      fallbackMessage: 'Failed to clip the source video.',
    });
  }
});
