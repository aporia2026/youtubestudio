import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { sql } from '@vercel/postgres';
import { VideoConfig } from '@/remotion/types';
import { logger } from '@/lib/logger';

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

  const renderId = `render_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  try {
    await ensureTable();
    await sql`
      INSERT INTO render_jobs (id, status, progress, started_at)
      VALUES (${renderId}, 'pending', 0, ${Date.now()})
    `;
  } catch (err) {
    logger.error('[render] DB insert failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create render job' }, { status: 500 });
  }

  // Kick off render — runs synchronously in this function instance
  // maxDuration = 300 keeps it alive long enough for short/medium videos
  startRender(renderId, config as VideoConfig).catch(err => {
    logger.error('[render] Fatal render error', { detail: err instanceof Error ? err.message : String(err) });
  });

  return NextResponse.json({ renderId }, { status: 202 });
}

// ─── GET /api/render/video?renderId=xxx — poll render status ──────────────────

export async function GET(req: NextRequest) {
  const renderId = req.nextUrl.searchParams.get('renderId');
  if (!renderId || !/^render_\d{1,15}_[a-f0-9]{8,12}$/.test(renderId)) {
    return NextResponse.json({ error: 'Invalid renderId' }, { status: 400 });
  }

  try {
    await ensureTable();
    const result = await sql<{
      id: string; status: string; progress: number;
      output_url: string | null; error: string | null;
      started_at: number; finished_at: number | null;
    }>`SELECT * FROM render_jobs WHERE id = ${renderId} LIMIT 1`;

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Render job not found' }, { status: 404 });
    }

    const job = result.rows[0];
    return NextResponse.json({
      renderId: job.id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.output_url,
      error: job.error,
      startedAt: job.started_at,
      elapsedMs: Date.now() - job.started_at,
    });
  } catch (err) {
    logger.error('[render] DB read failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to read render status' }, { status: 500 });
  }
}

// ─── Render logic ─────────────────────────────────────────────────────────────

async function updateJob(renderId: string, fields: {
  status?: string; progress?: number; output_url?: string; error?: string; finished_at?: number;
}) {
  // Use fully parameterized queries — no string interpolation of user-controlled values.
  const sets: string[] = [];
  const values: (string | number)[] = [];
  let p = 1;
  if (fields.status     !== undefined) { sets.push(`status = $${p++}`);      values.push(fields.status); }
  if (fields.progress   !== undefined) { sets.push(`progress = $${p++}`);    values.push(Math.max(0, Math.min(1, fields.progress))); }
  if (fields.output_url !== undefined) { sets.push(`output_url = $${p++}`);  values.push(fields.output_url); }
  if (fields.error      !== undefined) { sets.push(`error = $${p++}`);       values.push(fields.error.slice(0, 2000)); }
  if (fields.finished_at !== undefined) { sets.push(`finished_at = $${p++}`); values.push(fields.finished_at); }
  if (sets.length === 0) return;
  values.push(renderId);
  await sql.query(`UPDATE render_jobs SET ${sets.join(', ')} WHERE id = $${p}`, values);
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
      webpackOverride: (cfg) => cfg,
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
