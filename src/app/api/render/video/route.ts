import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { sql } from '@vercel/postgres';
import { VideoConfig } from '@/remotion/types';
import { logger } from '@/lib/logger';
import { remotionWebpackOverride } from '@/lib/remotion-bundler';
import {
  kickOffLambdaRender,
  pollLambdaProgress,
  lambdaConfigured,
} from '@/lib/remotion-lambda';
import {
  preflightLambdaQuota,
  shouldKillForOverspend,
  killOverspendingRender,
} from '@/lib/remotion-lambda-quotas';

// ─── Backend selection ────────────────────────────────────────────────────────

type RenderBackend = 'vercel' | 'lambda';

/**
 * Read RENDER_BACKEND env var. Default = 'vercel' so existing deploys
 * keep their current behavior. Flip to 'lambda' per-environment once
 * AWS bootstrap is complete (see _plans/2026-05-13-lambda-render-migration.md).
 * Falls back to 'vercel' silently if Lambda is requested but env is
 * incomplete — fail-open on the safer path rather than refusing renders.
 */
function selectRenderBackend(): RenderBackend {
  const requested = (process.env.RENDER_BACKEND ?? '').toLowerCase();
  if (requested === 'lambda' && lambdaConfigured()) return 'lambda';
  if (requested === 'lambda') {
    logger.warn('[render] RENDER_BACKEND=lambda requested but env incomplete; falling back to vercel');
  }
  return 'vercel';
}

// Extend Vercel function timeout — requires Vercel Pro (300s) or Enterprise (900s)
// On free tier this is ignored; local dev runs without limit
export const maxDuration = 300;

// ─── Input validation ─────────────────────────────────────────────────────────

function validateConfig(config: VideoConfig): string | null {
  if (!config || typeof config !== 'object') return 'Invalid config object';
  if (!Array.isArray(config.shots) || config.shots.length === 0) return 'No shots provided';
  if (config.shots.length > 500) return 'Too many shots (max 500)';
  if (!config.fps || config.fps < 24 || config.fps > 60) return 'Invalid fps (must be 24–60)';
  if (!config.width || config.width < 640 || config.width > 3840) return 'Invalid width (640–3840)';
  if (!config.height || config.height < 360 || config.height > 2160) return 'Invalid height (360–2160)';
  // Validate each shot has required fields
  for (const shot of config.shots) {
    if (typeof shot.startMs !== 'number' || typeof shot.durationMs !== 'number') {
      return 'Each shot must have numeric startMs and durationMs';
    }
    if (shot.durationMs <= 0) return 'Shot durationMs must be positive';
    if (shot.durationMs > 600_000) return 'Shot too long (max 10 minutes per shot)';
  }
  return null;
}

// ─── Ensure render_jobs table exists ─────────────────────────────────────────

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
  // Migration 0066 is the source of truth for these columns; the
  // ALTERs here are a dev-mode safety net in case migrations haven't
  // run yet. Idempotent.
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_render_id TEXT`;
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_bucket    TEXT`;
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS estimated_cost   REAL`;
}

// ─── POST /api/render/video — start a render job ──────────────────────────────

export async function POST(req: NextRequest) {
  let body: { config?: VideoConfig };
  try {
    body = await req.json() as { config?: VideoConfig };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { config } = body;
  const validationError = validateConfig(config as VideoConfig);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    await ensureTable();
  } catch (err) {
    logger.error('[render] ensureTable failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Render storage unavailable' }, { status: 500 });
  }

  const backend = selectRenderBackend();

  // Lambda backend: enforce spend + concurrency caps BEFORE creating a
  // render_jobs row so refused requests don't leave orphan rows. Vercel
  // backend has its own implicit cap (the 300s function ceiling).
  if (backend === 'lambda') {
    const preflight = await preflightLambdaQuota();
    if (!preflight.ok) {
      return NextResponse.json(
        { error: preflight.reason, retryAfterSeconds: preflight.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(preflight.retryAfterSeconds) } },
      );
    }
  }

  const renderId = `render_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  try {
    await sql`
      INSERT INTO render_jobs (id, status, progress, started_at)
      VALUES (${renderId}, 'pending', 0, ${Date.now()})
    `;
  } catch (err) {
    logger.error('[render] DB insert failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create render job' }, { status: 500 });
  }

  if (backend === 'lambda') {
    try {
      await startLambdaRender(renderId, config as VideoConfig);
    } catch (err) {
      logger.error('[render] Lambda kickoff failed', { detail: err instanceof Error ? err.message : String(err) });
      await updateJob(renderId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: Date.now(),
      }).catch(() => {});
      return NextResponse.json({ error: 'Failed to start Lambda render' }, { status: 500 });
    }
    return NextResponse.json({ renderId, backend }, { status: 202 });
  }

  // Vercel path — render runs synchronously in this function instance,
  // maxDuration = 300 keeps it alive long enough for short/medium videos.
  startRender(renderId, config as VideoConfig).catch(err => {
    logger.error('[render] Fatal render error', { detail: err instanceof Error ? err.message : String(err) });
  });

  return NextResponse.json({ renderId, backend }, { status: 202 });
}

// ─── GET /api/render/video?renderId=xxx — poll render status ──────────────────

export async function GET(req: NextRequest) {
  const renderId = req.nextUrl.searchParams.get('renderId');
  if (!renderId || !/^render_\d{1,15}_[a-f0-9]{8,12}$/.test(renderId)) {
    return NextResponse.json({ error: 'Invalid renderId' }, { status: 400 });
  }

  type RenderJobRow = {
    id: string; status: string; progress: number;
    output_url: string | null; error: string | null;
    started_at: number; finished_at: number | null;
    lambda_render_id: string | null; lambda_bucket: string | null;
    estimated_cost: number | null;
  };

  try {
    await ensureTable();
    const result = await sql<RenderJobRow>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Render job not found' }, { status: 404 });
    }

    let job = result.rows[0];

    // Lambda-backed job that hasn't reached a terminal state — refresh
    // from Lambda before responding so the client sees fresh progress.
    if (
      job.lambda_render_id && job.lambda_bucket &&
      job.status !== 'done' && job.status !== 'error'
    ) {
      try {
        const snap = await pollLambdaProgress({
          lambdaRenderId: job.lambda_render_id,
          bucketName: job.lambda_bucket,
        });
        const fields: Parameters<typeof updateJob>[1] = {
          progress: snap.overallProgress,
          estimated_cost: snap.costAccrued,
        };
        // Per-render spend cap: if this render has blown past the cap,
        // abort it on Lambda + mark the row 'error' before responding.
        // Checked BEFORE the done / fatalError branches so a runaway is
        // killed even if Lambda is still happily reporting progress.
        const kill = shouldKillForOverspend(snap.costAccrued);
        if (kill.shouldKill && !snap.done) {
          await killOverspendingRender({
            lambdaRenderId: job.lambda_render_id,
            bucketName: job.lambda_bucket,
          });
          fields.status = 'error';
          fields.error = kill.reason ?? 'Render exceeded per-render spend cap.';
          fields.finished_at = Date.now();
        } else if (snap.fatalError) {
          fields.status = 'error';
          fields.error = snap.fatalError;
          fields.finished_at = Date.now();
        } else if (snap.done && snap.outputFile) {
          fields.status = 'done';
          fields.progress = 1;
          fields.output_url = snap.outputFile;
          fields.finished_at = Date.now();
        }
        await updateJob(renderId, fields);
        // Re-read so the response reflects the post-update row.
        const refreshed = await sql<RenderJobRow>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;
        if (refreshed.rows.length > 0) job = refreshed.rows[0];
      } catch (err) {
        // Polling failure is non-fatal — return whatever the DB has.
        logger.warn('[render] Lambda poll failed', { renderId, detail: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json({
      renderId: job.id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.output_url,
      error: job.error,
      startedAt: job.started_at,
      elapsedMs: Date.now() - job.started_at,
      estimatedCost: job.estimated_cost,
    });
  } catch (err) {
    logger.error('[render] DB read failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to read render status' }, { status: 500 });
  }
}

// ─── Render logic ─────────────────────────────────────────────────────────────

async function updateJob(renderId: string, fields: {
  status?: string; progress?: number; output_url?: string; error?: string; finished_at?: number;
  lambda_render_id?: string; lambda_bucket?: string; estimated_cost?: number;
}) {
  // Use fully parameterized queries — no string interpolation of user-controlled values.
  const sets: string[] = [];
  const values: (string | number)[] = [];
  let p = 1;
  if (fields.status           !== undefined) { sets.push(`status = $${p++}`);           values.push(fields.status); }
  if (fields.progress         !== undefined) { sets.push(`progress = $${p++}`);         values.push(Math.max(0, Math.min(1, fields.progress))); }
  if (fields.output_url       !== undefined) { sets.push(`output_url = $${p++}`);       values.push(fields.output_url); }
  if (fields.error            !== undefined) { sets.push(`error = $${p++}`);            values.push(fields.error.slice(0, 2000)); }
  if (fields.finished_at      !== undefined) { sets.push(`finished_at = $${p++}`);      values.push(fields.finished_at); }
  if (fields.lambda_render_id !== undefined) { sets.push(`lambda_render_id = $${p++}`); values.push(fields.lambda_render_id); }
  if (fields.lambda_bucket    !== undefined) { sets.push(`lambda_bucket = $${p++}`);    values.push(fields.lambda_bucket); }
  if (fields.estimated_cost   !== undefined) { sets.push(`estimated_cost = $${p++}`);   values.push(fields.estimated_cost); }
  if (sets.length === 0) return;
  values.push(renderId);
  await sql.query(`UPDATE render_jobs SET ${sets.join(', ')} WHERE id = $${p}`, values);
}

/**
 * Lambda kickoff. Distinct from `startRender`: this returns in
 * ~100–300ms once Lambda has the job, and the actual render proceeds
 * remotely. Progress + completion are observed via GET poll → Lambda
 * `getRenderProgress` (see GET handler above).
 *
 * Throws if Lambda is misconfigured or AWS rejects the request — caller
 * is the POST handler, which marks the job 'error' on throw.
 */
async function startLambdaRender(renderId: string, config: VideoConfig) {
  await updateJob(renderId, { status: 'rendering', progress: 0.01 });

  const { lambdaRenderId, bucketName } = await kickOffLambdaRender({
    compositionId: 'YouTubeVideo',
    inputProps: { config },
    codec: 'h264',
  });

  await updateJob(renderId, {
    lambda_render_id: lambdaRenderId,
    lambda_bucket: bucketName,
    progress: 0.03,
  });
}

async function startRender(renderId: string, config: VideoConfig) {
  try {
    await updateJob(renderId, { status: 'rendering', progress: 0.02 });

    // Dynamic imports — Remotion bundler/renderer are Node.js only, not Turbopack-compatible
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');
    const { put } = await import('@vercel/blob');

    await updateJob(renderId, { progress: 0.05 });

    const rootEntry = path.join(process.cwd(), 'src', 'remotion', 'Root.tsx');

    // Bundle (30–60s for first bundle, faster with cache)
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
      id: 'YouTubeVideo',
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

    const fileBuffer = await fs.readFile(outPath);
    const blob = await put(
      `renders/${renderId}.mp4`,
      fileBuffer,
      { access: 'public', contentType: 'video/mp4', addRandomSuffix: false },
    );

    await fs.unlink(outPath).catch((e) => console.warn('[render] temp file cleanup failed:', e));
    await updateJob(renderId, {
      status: 'done',
      progress: 1,
      output_url: blob.url,
      finished_at: Date.now(),
    });

  } catch (err) {
    logger.error(`[render] Job ${renderId} failed:`, { detail: err instanceof Error ? err.message : String(err) });
    await updateJob(renderId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finished_at: Date.now(),
    }).catch(() => {});
    throw err;
  }
}
