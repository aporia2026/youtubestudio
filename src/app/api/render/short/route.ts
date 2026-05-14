import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { getShort } from '@/lib/shorts';
import { buildShortVideoConfig } from '@/lib/shorts-render';
import type { ShortVideoConfig } from '@/lib/shorts-render-types';
import { logger } from '@/lib/logger';
import { remotionWebpackOverride } from '@/lib/remotion-bundler';
import {
  buildShortRenderKey,
  getDownloadUrlForBucket,
  getReviewBucket,
  getShortRenderDownloadAttachmentUrl,
  uploadToBucket,
} from '@/lib/r2';

// Vertical Shorts render — same Remotion bundler/renderer pattern as
// /api/render/video. Vercel Pro 300s ceiling is enough for typical
// 30-60s Shorts.
export const maxDuration = 300;

// Reuses the existing render_jobs table from /api/render/video — no
// separate schema. Job ids prefixed `short_` so we can tell them apart.
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS render_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL NOT NULL DEFAULT 0,
      output_url TEXT,
      error TEXT,
      started_at BIGINT NOT NULL,
      finished_at BIGINT
    )
  `;
}

async function updateJob(
  renderId: string,
  fields: { status?: string; progress?: number; output_url?: string; error?: string; finished_at?: number },
) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let p = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k} = $${p++}`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(renderId);
  await sql.query(`UPDATE render_jobs SET ${sets.join(', ')} WHERE id = $${p}`, values);
}

/**
 * POST /api/render/short
 *
 * Body: { shortId: string, channelName?: string, background?: string, accentColor?: string }
 *
 * Synchronously kicks off a Remotion render of the given Short. Returns
 * a renderId immediately; client polls GET ?renderId=… until status
 * flips to 'done' (with output_url) or 'error'.
 *
 * On success, the rendered_video_url column on the shorts row is also
 * populated so the /shorts page reflects the result without a separate
 * DB hop.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const shortId = typeof b.shortId === 'string' ? b.shortId : '';
  if (!shortId) return NextResponse.json({ error: 'shortId is required' }, { status: 400 });

  const short = await getShort(shortId, session.ws);
  if (!short) return NextResponse.json({ error: 'Short not found' }, { status: 404 });
  if (!short.voiceover_audio_url) {
    return NextResponse.json(
      { error: 'Voiceover not generated yet — click Voiceover on /shorts first.' },
      { status: 409 },
    );
  }

  let config: ShortVideoConfig;
  try {
    config = buildShortVideoConfig({
      short,
      channelName: typeof b.channelName === 'string' ? b.channelName : null,
      background: typeof b.background === 'string' ? b.background : undefined,
      accentColor: typeof b.accentColor === 'string' ? b.accentColor : undefined,
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'render-short: build config',
      knownPatterns: [
        // buildShortVideoConfig surfaces user-actionable validation messages.
        { match: /Cannot render Short/, status: 400 },
        { match: /voiceover not generated/, status: 400 },
      ],
      fallbackStatus: 400,
      fallbackMessage: 'Invalid Short configuration — please review and try again.',
    });
  }

  await ensureTable();
  const renderId = `short_${Date.now()}_${shortId.replace(/-/g, '').slice(0, 12)}`;
  try {
    await sql`
      INSERT INTO render_jobs (id, status, progress, started_at)
      VALUES (${renderId}, 'pending', 0, ${Date.now()})
    `;
  } catch (err) {
    logger.error('short-render: DB insert failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create render job' }, { status: 500 });
  }

  // Fire-and-forget. The function instance keeps running until the render
  // finishes OR maxDuration kicks in. The client polls GET to watch progress.
  startRender(renderId, config, shortId, session.ws).catch((err) => {
    logger.error('short-render: fatal', { renderId, detail: err instanceof Error ? err.message : String(err) });
  });

  return NextResponse.json({ renderId }, { status: 202 });
});

/**
 * GET /api/render/short?renderId=short_…
 */
export const GET = apiRoute.authed(async (_session, req: NextRequest) => {
  const renderId = req.nextUrl.searchParams.get('renderId');
  if (!renderId || !/^short_\d+_[a-f0-9]{8,12}$/.test(renderId)) {
    return NextResponse.json({ error: 'Invalid renderId' }, { status: 400 });
  }
  await ensureTable();
  const { rows } = await sql<{
    id: string;
    status: string;
    progress: number;
    output_url: string | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  }>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;
  const job = rows[0];
  if (!job) return NextResponse.json({ error: 'Render not found' }, { status: 404 });
  // `output_url` backs the in-page <video> preview; `download_url` is a
  // presigned R2 URL with `response-content-disposition: attachment`
  // baked in so the browser saves the bytes direct from R2 — skipping
  // /api/download-proxy and its 300s function timeout. Minted only once
  // the render is done.
  let download_url: string | null = null;
  if (job.status === 'done' && job.output_url) {
    try {
      download_url = await getShortRenderDownloadAttachmentUrl(job.id, `short-${job.id}.mp4`);
    } catch (err) {
      logger.warn('[short-render] downloadUrl mint failed', {
        renderId: job.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({
    renderId: job.id,
    status: job.status,
    progress: job.progress,
    output_url: job.output_url,
    download_url,
    error: job.error,
    started_at: Number(job.started_at),
    finished_at: job.finished_at ? Number(job.finished_at) : null,
  });
});

async function startRender(
  renderId: string,
  config: ShortVideoConfig,
  shortId: string,
  workspaceId: string,
) {
  try {
    await updateJob(renderId, { status: 'rendering', progress: 0.02 });

    // Dynamic imports — Remotion bundler / renderer are Node-only and
    // not Turbopack-compatible.
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    await updateJob(renderId, { progress: 0.05 });

    const rootEntry = path.join(process.cwd(), 'src', 'remotion', 'Root.tsx');
    const bundled = await bundle({
      entryPoint: rootEntry,
      webpackOverride: remotionWebpackOverride,
      onProgress: (p) => {
        updateJob(renderId, { progress: 0.05 + p * 0.30 }).catch(() => {});
      },
    });

    await updateJob(renderId, { progress: 0.36 });

    const composition = await selectComposition({
      serveUrl: bundled,
      id: 'ShortVideo',
      inputProps: { config },
    });

    await updateJob(renderId, { progress: 0.40 });

    const outPath = path.join(os.tmpdir(), `${renderId}.mp4`);
    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: 'h264',
      outputLocation: outPath,
      inputProps: { config },
      onProgress: ({ progress: p }) => {
        updateJob(renderId, { progress: 0.40 + p * 0.50 }).catch(() => {});
      },
    });

    await updateJob(renderId, { progress: 0.92 });

    // Upload to R2 (review bucket, `shorts-renders/` prefix). Same
    // reasoning as the long-form render migration: consistent storage
    // across the app, and private-access Blob stores don't break the
    // output URL.
    const fileBuffer = await fs.readFile(outPath);
    const bucket = getReviewBucket();
    const r2Key = buildShortRenderKey(renderId);
    await uploadToBucket(bucket, r2Key, fileBuffer, 'video/mp4');
    const outputUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_PUBLIC_URL);

    await fs.unlink(outPath).catch(() => {});

    // Persist onto the shorts row so the /shorts page sees it on next refresh.
    await sql`
      UPDATE shorts
         SET rendered_video_url = ${outputUrl},
             updated_at = NOW()
       WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
    `.catch(() => { /* row was deleted while we were rendering — leave the job done anyway */ });

    await updateJob(renderId, {
      status: 'done',
      progress: 1,
      output_url: outputUrl,
      finished_at: Date.now(),
    });
  } catch (err) {
    await updateJob(renderId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finished_at: Date.now(),
    }).catch(() => {});
    throw err;
  }
}
