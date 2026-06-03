import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { getShort } from '@/lib/shorts';
import { buildShortVideoConfig, shortAlignmentScript } from '@/lib/shorts-render';
import type { ShortVideoConfig } from '@/lib/shorts-render-types';
import {
  buildCanonicalScript,
  ensureAlignmentForVoiceover,
} from '@/lib/voiceover-alignment-cache';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import { logger } from '@/lib/logger';
import { remotionWebpackOverride } from '@/lib/remotion-bundler';
import {
  kickOffLambdaRender,
  pollLambdaProgress,
  lambdaConfigured,
} from '@/lib/remotion-lambda';
import { getLambdaOutputDownloadUrl } from '@/lib/lambda-s3';
import {
  buildRenderDownloadFilename,
  buildShortRenderKey,
  getDownloadUrlForBucket,
  getReviewBucket,
  getShortRenderDownloadAttachmentUrl,
  uploadToBucket,
} from '@/lib/r2';

// Vertical Shorts render. Two backends, same as /api/render/video:
//   - 'lambda' (preferred): renders on AWS Lambda via the pre-deployed
//     Remotion site. No in-function bundling, so it sidesteps the rspack /
//     250MB / headless-Chrome walls that make in-function bundling unviable
//     on Vercel.
//   - 'vercel' (fallback): in-function bundle() + renderMedia(). Only works
//     where the Remotion toolchain + a browser are available; on Vercel it
//     fails to load @remotion/bundler. Kept for local/dev parity.
export const maxDuration = 300;

type RenderBackend = 'vercel' | 'lambda';

/** RENDER_BACKEND env: 'lambda' when configured, else 'vercel'. Mirrors
 *  /api/render/video so both render routes pick the same backend. */
function selectRenderBackend(): RenderBackend {
  const requested = (process.env.RENDER_BACKEND ?? '').toLowerCase();
  if (requested === 'lambda' && lambdaConfigured()) return 'lambda';
  if (requested === 'lambda') {
    logger.warn('[short-render] RENDER_BACKEND=lambda requested but env incomplete; falling back to vercel');
  }
  return 'vercel';
}

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
  // Idempotent safety net — long-form route's ensureTable() carries the
  // canonical column list. `title` here is the short's title (when set)
  // and feeds the user-facing Download filename.
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS title TEXT`;
  // Lambda backend bookkeeping (shared columns, migration 0066) + the
  // short_id / workspace_id needed to write rendered_video_url back onto
  // the shorts row when a Lambda render finishes (the GET poll has no
  // session, so it reads them off the job).
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_render_id TEXT`;
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_bucket    TEXT`;
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS short_id         TEXT`;
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS workspace_id     TEXT`;
}

async function updateJob(
  renderId: string,
  fields: {
    status?: string;
    progress?: number;
    output_url?: string;
    error?: string;
    finished_at?: number;
    lambda_render_id?: string;
    lambda_bucket?: string;
  },
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

  // Snap caption timing to real ElevenLabs word boundaries — the same
  // forced-alignment the editor preview uses (GET /api/shorts/[id]/alignment).
  // Built from the identical canonical script so the cache key matches the
  // editor's, meaning the render almost always hits the warm cache the
  // preview populated and the final MP4 matches what the user saw. Best
  // effort: on any failure we fall back to proportional-WPM timing rather
  // than blocking the render.
  let alignment: ForcedAlignmentResponse | null = null;
  if (short.short_script) {
    try {
      const canonical = buildCanonicalScript([shortAlignmentScript(short.short_script)]);
      const result = await ensureAlignmentForVoiceover(short.voiceover_audio_url, canonical);
      if (result.status === 'ready') {
        alignment = result.alignment;
      } else {
        logger.warn('[short-render] alignment not ready — using proportional timing', {
          shortId,
          reason: result.reason,
        });
      }
    } catch (err) {
      logger.warn('[short-render] alignment failed — using proportional timing', {
        shortId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let config: ShortVideoConfig;
  try {
    config = buildShortVideoConfig({
      short,
      channelName: typeof b.channelName === 'string' ? b.channelName : null,
      background: typeof b.background === 'string' ? b.background : undefined,
      accentColor: typeof b.accentColor === 'string' ? b.accentColor : undefined,
      alignment,
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
  // Snapshot the short's title at job-creation time. If the user
  // renames the short mid-render, the Download filename still reflects
  // what the user intended when they kicked off the render.
  const title = short.title?.trim() ? short.title.trim().slice(0, 200) : null;
  try {
    await sql`
      INSERT INTO render_jobs (id, status, progress, started_at, title, short_id, workspace_id)
      VALUES (${renderId}, 'pending', 0, ${Date.now()}, ${title}, ${shortId}, ${session.ws})
    `;
  } catch (err) {
    logger.error('short-render: DB insert failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create render job' }, { status: 500 });
  }

  const backend = selectRenderBackend();

  // Lambda: kickoff returns in ~300ms; the render proceeds on AWS and the
  // client watches it via the GET poll (which refreshes from Lambda).
  if (backend === 'lambda') {
    try {
      await startLambdaRender(renderId, config);
    } catch (err) {
      logger.error('short-render: Lambda kickoff failed', { renderId, detail: err instanceof Error ? err.message : String(err) });
      await updateJob(renderId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: Date.now(),
      }).catch(() => {});
      return NextResponse.json({ error: 'Failed to start Lambda render' }, { status: 500 });
    }
    return NextResponse.json({ renderId, backend }, { status: 202 });
  }

  // Vercel (fallback): fire-and-forget in-function render. Keeps the
  // function alive until the render finishes OR maxDuration kicks in.
  startRender(renderId, config, shortId, session.ws).catch((err) => {
    logger.error('short-render: fatal', { renderId, detail: err instanceof Error ? err.message : String(err) });
  });

  return NextResponse.json({ renderId, backend }, { status: 202 });
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
  type ShortRenderJobRow = {
    id: string;
    status: string;
    progress: number;
    output_url: string | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    title: string | null;
    lambda_render_id: string | null;
    lambda_bucket: string | null;
    short_id: string | null;
    workspace_id: string | null;
  };
  const { rows } = await sql<ShortRenderJobRow>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;
  let job = rows[0];
  if (!job) return NextResponse.json({ error: 'Render not found' }, { status: 404 });

  // Lambda-backed job mid-flight — refresh from Lambda so the client sees
  // live progress, and on completion stamp the output + the shorts row.
  if (
    job.lambda_render_id && job.lambda_bucket &&
    job.status !== 'done' && job.status !== 'error'
  ) {
    try {
      const snap = await pollLambdaProgress({
        lambdaRenderId: job.lambda_render_id,
        bucketName: job.lambda_bucket,
      });
      const fields: Parameters<typeof updateJob>[1] = { progress: snap.overallProgress };
      if (snap.fatalError) {
        fields.status = 'error';
        fields.error = snap.fatalError;
        fields.finished_at = Date.now();
      } else if (snap.done && snap.outputFile) {
        fields.status = 'done';
        fields.progress = 1;
        fields.output_url = snap.outputFile;
        fields.finished_at = Date.now();
        // Mirror the in-function path: surface the result on the shorts row.
        if (job.short_id && job.workspace_id) {
          await sql`
            UPDATE shorts SET rendered_video_url = ${snap.outputFile}, updated_at = NOW()
             WHERE id = ${job.short_id}::uuid AND workspace_id = ${job.workspace_id}::uuid
          `.catch(() => { /* row deleted mid-render — leave the job done */ });
        }
      }
      await updateJob(renderId, fields);
      const refreshed = await sql<ShortRenderJobRow>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;
      if (refreshed.rows.length > 0) job = refreshed.rows[0];
    } catch (err) {
      logger.warn('[short-render] Lambda poll failed', { renderId, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // `output_url` backs the in-page <video> preview; `download_url` is a
  // presigned URL with `response-content-disposition: attachment` baked in
  // so the browser saves the bytes direct from R2 / Lambda S3 — skipping
  // /api/download-proxy and its 300s timeout. Minted only once the render
  // is done.
  let download_url: string | null = null;
  if (job.status === 'done' && job.output_url) {
    const filename = buildRenderDownloadFilename(
      job.title,
      job.finished_at ? Number(job.finished_at) : null,
      `short-${job.id}`,
    );
    try {
      download_url = job.lambda_render_id
        ? await getLambdaOutputDownloadUrl(job.output_url, filename)
        : await getShortRenderDownloadAttachmentUrl(job.id, filename);
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

/**
 * Lambda kickoff for the ShortVideo composition. Returns in ~100-300ms
 * with the ids the GET poll needs; the render proceeds on AWS against the
 * pre-deployed Remotion site (which registers ShortVideo). Throws if Lambda
 * is misconfigured or AWS rejects — the POST handler marks the job 'error'.
 */
async function startLambdaRender(renderId: string, config: ShortVideoConfig) {
  await updateJob(renderId, { status: 'rendering', progress: 0.01 });
  const { lambdaRenderId, bucketName } = await kickOffLambdaRender({
    compositionId: 'ShortVideo',
    inputProps: { config },
    codec: 'h264',
  });
  await updateJob(renderId, {
    lambda_render_id: lambdaRenderId,
    lambda_bucket: bucketName,
    progress: 0.03,
  });
}

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
