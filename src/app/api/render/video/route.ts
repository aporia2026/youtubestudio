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
import {
  ensureAlignmentForVoiceover,
  buildCanonicalScript,
} from '@/lib/voiceover-alignment-cache';
import { stripProductionMarkers } from '@/lib/script-markers';
import { realignVideoConfig } from '@/remotion/utils';
import {
  buildRenderDownloadFilename,
  buildRenderKey,
  getDownloadUrlForBucket,
  getRenderDownloadAttachmentUrl,
  getReviewBucket,
  uploadToBucket,
} from '@/lib/r2';
import { getLambdaOutputDownloadUrl } from '@/lib/lambda-s3';

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
  // `title` is the production-doc title (or video-studio scratch title)
  // sent with the POST. Used to build a human-readable Download filename
  // — see `buildRenderDownloadFilename` in `r2.ts`. Nullable: legacy rows
  // and scratch-mode renders without a title fall back to the renderId.
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS title           TEXT`;
  // 2026-05-20: videoUrl HEAD-probe results, stashed for the GET status
  // endpoint so creators can read them in the browser without digging
  // through Vercel function logs. JSONB so we can query `->`/`->>` if
  // a recurring failure pattern emerges. Nullable: pre-probe rows and
  // renders with zero videoUrls leave it null.
  await sql`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS probe_results JSONB`;
}

// ─── Absolutize same-origin URLs before sending to a remote renderer ─────────

/**
 * Lambda fetches every URL referenced in the VideoConfig from its own
 * machine. A relative path like `/api/voiceovers/<uuid>/audio` works
 * fine in the browser (resolves against window.origin) but on Lambda
 * gets interpreted as a key on Remotion's own S3 bucket — 403
 * AccessDenied because nothing's there.
 *
 * Walk the config's audio + music URL fields and rewrite any leading-slash
 * path to a full https URL against the request's origin. Image URLs in
 * shots already come from R2 with absolute https, so they stay untouched.
 */
function absolutizeMediaUrls(config: VideoConfig, origin: string): VideoConfig {
  function toAbsolute(url: string | undefined): string | undefined {
    if (!url) return url;
    if (url.startsWith('/')) return new URL(url, origin).toString();
    return url;
  }
  return {
    ...config,
    voiceoverUrl: toAbsolute(config.voiceoverUrl),
    musicUrl: toAbsolute(config.musicUrl),
  };
}

// ─── Voiceover alignment resolution ───────────────────────────────────────────

/**
 * Same-origin shape the production-doc page sends. Identical to the
 * one `/api/voiceovers/align` validates — duplicated here on purpose
 * so the render route doesn't depend on internal imports from the
 * other route module.
 */
const VOICEOVER_PATH_RE =
  /^\/api\/voiceovers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/audio$/i;

interface VoiceoverAlignmentRequest {
  audioPath: string;
  rowScripts: string[];
}

/**
 * Validate the optional `voiceoverAlignment` block. Returns `null`
 * when it's absent or shaped wrong (failure is non-fatal — we just
 * render with estimated timing). On valid input, returns the
 * trimmed payload ready to feed `ensureAlignmentForVoiceover`.
 */
function validateAlignmentRequest(raw: unknown): VoiceoverAlignmentRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.audioPath !== 'string' || !VOICEOVER_PATH_RE.test(r.audioPath)) return null;
  if (!Array.isArray(r.rowScripts) || r.rowScripts.length === 0) return null;
  if (r.rowScripts.length > 500) return null;
  for (const s of r.rowScripts) {
    if (typeof s !== 'string') return null;
  }
  return { audioPath: r.audioPath, rowScripts: r.rowScripts as string[] };
}

/**
 * Resolve voiceover alignment and apply it to the config. Returns the
 * (possibly re-timed) config plus a brief telemetry record. Failure
 * is silent — render proceeds with estimated timing and the failure
 * reason is logged. The plan calls for this non-fatal posture so a
 * busted ElevenLabs key never blocks a render.
 */
async function maybeRealignConfig(
  config: VideoConfig,
  alignmentReq: VoiceoverAlignmentRequest,
  origin: string,
): Promise<{ config: VideoConfig; telemetry: Record<string, unknown> }> {
  const stripped = alignmentReq.rowScripts.map((s) => stripProductionMarkers(s));
  const canonicalScript = buildCanonicalScript(stripped);
  if (!canonicalScript.trim()) {
    return { config, telemetry: { aligned: false, reason: 'empty-script' } };
  }
  const absoluteUrl = new URL(alignmentReq.audioPath, origin).toString();

  const result = await ensureAlignmentForVoiceover(absoluteUrl, canonicalScript).catch((err) => {
    // `ensureAlignmentForVoiceover` already swallows expected failures
    // into a typed result — this catch only fires on truly unexpected
    // errors (e.g. DB outage during the cache read). Render keeps going.
    logger.warn('[render] alignment resolution threw', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (!result || result.status !== 'ready') {
    return {
      config,
      telemetry: {
        aligned: false,
        reason: result?.status === 'failed' ? result.reason : 'unavailable',
      },
    };
  }

  const realigned = realignVideoConfig(config, result.alignment);
  const alignedCount = realigned.alignedRows.filter((r) => r.source === 'aligned').length;
  const estimatedCount = realigned.alignedRows.length - alignedCount;

  return {
    config: realigned.config,
    telemetry: {
      aligned: true,
      cached: result.cached,
      alignedCount,
      estimatedCount,
      costUsd: result.cost,
    },
  };
}

// ─── POST /api/render/video — start a render job ──────────────────────────────

export async function POST(req: NextRequest) {
  let body: { config?: VideoConfig; voiceoverAlignment?: unknown; title?: unknown };
  try {
    body = await req.json() as { config?: VideoConfig; voiceoverAlignment?: unknown; title?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { config } = body;
  // Title is purely cosmetic — only used to build the user-facing
  // Download filename. Coerce non-strings to null so a malformed client
  // body doesn't break the INSERT.
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : null;
  const validationError = validateConfig(config as VideoConfig);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Optional voiceover alignment resolution. Runs before the render
  // job is created so an alignment-time DB outage doesn't leave an
  // orphan 'pending' row; once we're past this block, the config is
  // the final input to the renderer.
  let effectiveConfig = absolutizeMediaUrls(config as VideoConfig, req.nextUrl.origin);
  let alignmentTelemetry: Record<string, unknown> = { aligned: false, reason: 'not-requested' };
  const alignmentReq = validateAlignmentRequest(body.voiceoverAlignment);
  if (alignmentReq) {
    const resolved = await maybeRealignConfig(effectiveConfig, alignmentReq, req.nextUrl.origin);
    effectiveConfig = resolved.config;
    alignmentTelemetry = resolved.telemetry;
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
      INSERT INTO render_jobs (id, status, progress, started_at, title)
      VALUES (${renderId}, 'pending', 0, ${Date.now()}, ${title})
    `;
  } catch (err) {
    logger.error('[render] DB insert failed', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create render job' }, { status: 500 });
  }

  // Log alignment outcome alongside the renderId so a failed alignment
  // shows up in the same trace as the render that proceeded without it.
  logger.info('[render] alignment outcome', { renderId, ...alignmentTelemetry });

  // 2026-05-20: pre-flight probe for the per-shot videoUrls. Tests up to 3
  // unique videoUrls with a HEAD request from the Vercel function itself,
  // logging status + first response header per URL. When Remotion's
  // server-side OffthreadVideo fails to fetch a video (any reason —
  // CORS, presigned-URL clock skew, R2 outage, content-type mismatch),
  // BRollScene falls back silently to the still image path and the
  // creator sees a stills-only MP4 even though the config carried real
  // videoUrls. Without this probe the failure is invisible. Cheap: ~3
  // HEAD requests, total under a second, no body transfer. Errors caught
  // — never blocks the render itself, only annotates the log.
  const uniqueVideoUrls = Array.from(
    new Set(
      effectiveConfig.shots
        .map((s) => s.videoUrl)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    ),
  );
  let probePayload: unknown = { totalUniqueVideoUrls: uniqueVideoUrls.length };
  if (uniqueVideoUrls.length > 0) {
    const sample = uniqueVideoUrls.slice(0, 3);
    const probeResults = await Promise.all(
      sample.map(async (url) => {
        try {
          // GET with Range: 0-0, not HEAD. S3 SigV4 presigns include the
          // HTTP method in the canonical request, so a URL signed for
          // GetObject returns 403 to HEAD — even when the URL is
          // perfectly valid for the real download. Range: bytes=0-0
          // gets us 1 byte (206 Partial Content), enough to verify the
          // URL works without transferring the whole video. The
          // response body is read and discarded so the socket closes.
          const res = await fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
          });
          // Drain the body to release the socket. 1 byte at most.
          try { await res.arrayBuffer(); } catch { /* drain best-effort */ }
          return {
            host: new URL(url).host,
            status: res.status,
            ok: res.ok || res.status === 206,
            contentType: res.headers.get('content-type'),
            contentLength: res.headers.get('content-length'),
            contentRange: res.headers.get('content-range'),
            acceptRanges: res.headers.get('accept-ranges'),
          };
        } catch (err) {
          return {
            host: (() => {
              try { return new URL(url).host; } catch { return 'unparseable'; }
            })(),
            status: 'fetch-threw',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    probePayload = {
      totalUniqueVideoUrls: uniqueVideoUrls.length,
      probedCount: sample.length,
      results: probeResults,
    };
    logger.info('[render] videoUrl probe', { renderId, ...probePayload as Record<string, unknown> });
  } else {
    logger.info('[render] videoUrl probe', {
      renderId,
      totalUniqueVideoUrls: 0,
      note: 'no videoUrls in config — render will use stills + Ken Burns only',
    });
  }
  // Persist the probe so the creator can pull it from the GET status
  // endpoint in their browser instead of digging through Vercel logs.
  // Non-blocking — diagnostics never fail the render itself.
  await updateJob(renderId, { probe_results: probePayload }).catch((err) => {
    logger.warn('[render] probe persist failed', {
      renderId,
      detail: err instanceof Error ? err.message : String(err),
    });
  });

  if (backend === 'lambda') {
    try {
      await startLambdaRender(renderId, effectiveConfig);
    } catch (err) {
      logger.error('[render] Lambda kickoff failed', { detail: err instanceof Error ? err.message : String(err) });
      await updateJob(renderId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: Date.now(),
      }).catch(() => {});
      return NextResponse.json({ error: 'Failed to start Lambda render' }, { status: 500 });
    }
    return NextResponse.json({ renderId, backend, alignment: alignmentTelemetry }, { status: 202 });
  }

  // Vercel path — render runs synchronously in this function instance,
  // maxDuration = 300 keeps it alive long enough for short/medium videos.
  startRender(renderId, effectiveConfig).catch(err => {
    logger.error('[render] Fatal render error', { detail: err instanceof Error ? err.message : String(err) });
  });

  return NextResponse.json({ renderId, backend, alignment: alignmentTelemetry }, { status: 202 });
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
    title: string | null;
    probe_results: unknown | null;
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

    // `outputUrl` backs the in-page <Player> preview (range playback);
    // `downloadUrl` is a separate presigned URL with `response-content-
    // disposition: attachment` baked in so the browser saves the bytes
    // direct from R2 / Lambda S3 — bypassing /api/download-proxy and its
    // 300s function timeout that truncated multi-GB renders. Minted only
    // when the render has finished; null otherwise.
    let downloadUrl: string | null = null;
    if (job.status === 'done' && job.output_url) {
      const filename = buildRenderDownloadFilename(job.title, job.finished_at, `render-${job.id}`);
      try {
        downloadUrl = job.lambda_render_id
          ? await getLambdaOutputDownloadUrl(job.output_url, filename)
          : await getRenderDownloadAttachmentUrl(job.id, filename);
      } catch (err) {
        // Presigning failure is non-fatal — fall through with null
        // downloadUrl. The client just doesn't render a Download link
        // until the next successful poll.
        logger.warn('[render] downloadUrl mint failed', {
          renderId: job.id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      renderId: job.id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.output_url,
      downloadUrl,
      error: job.error,
      startedAt: job.started_at,
      elapsedMs: Date.now() - job.started_at,
      estimatedCost: job.estimated_cost,
      // 2026-05-20: videoUrl HEAD-probe results. Lets the creator see
      // in their browser whether the Vercel server can reach the
      // per-shot video URLs (R2 presigned) without digging through
      // Vercel function logs. Null on pre-probe rows or zero-video
      // renders.
      probeResults: job.probe_results,
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
  probe_results?: unknown;
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
  if (fields.probe_results    !== undefined) { sets.push(`probe_results = $${p++}::jsonb`); values.push(JSON.stringify(fields.probe_results)); }
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

    // 2026-05-20: capture browser console errors + asset downloads
    // from inside the Remotion render. Without these hooks an
    // OffthreadVideo fetch/decode failure is invisible — BRollScene's
    // onError fires, the scene falls back to the still-image path,
    // and the render completes with no animations. Logging here shows
    // the actual error message and download events in the Vercel
    // function log for the next render.
    const browserErrors: string[] = [];
    let videoDownloads = 0;
    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: 'h264',
      outputLocation: outPath,
      inputProps: { config },
      onProgress: ({ progress: p }) => {
        updateJob(renderId, { progress: 0.40 + p * 0.50 }).catch(() => {});
      },
      onBrowserLog: (log) => {
        if (log.type === 'error' || log.type === 'warning') {
          if (browserErrors.length < 50) {
            browserErrors.push(`[${log.type}] ${log.text}`.slice(0, 800));
          }
          logger.warn('[render browser log]', {
            renderId,
            type: log.type,
            text: log.text.slice(0, 500),
          });
        }
      },
    });
    // Annotate the row with browser errors + download summary so the
    // GET status endpoint can surface them in the browser without
    // overwriting the earlier HEAD probe. Merged into probe_results
    // under a `postRender` key.
    logger.info('[render] media render complete', {
      renderId,
      browserErrorCount: browserErrors.length,
      videoDownloads,
    });
    if (browserErrors.length > 0) {
      logger.warn('[render] browser errors during render', {
        renderId,
        count: browserErrors.length,
        first: browserErrors.slice(0, 5),
      });
    }

    await updateJob(renderId, { progress: 0.92 });

    // Upload to R2 (review bucket, `renders/` prefix) instead of Vercel
    // Blob. Mirrors the migration of the Lambda render path: every other
    // media write in the app uses R2, and private-access Blob stores
    // (Vercel's new default) silently break this fallback.
    const fileBuffer = await fs.readFile(outPath);
    const bucket = getReviewBucket();
    const r2Key = buildRenderKey(renderId);
    await uploadToBucket(bucket, r2Key, fileBuffer, 'video/mp4');
    const outputUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_PUBLIC_URL);

    await fs.unlink(outPath).catch((e) => console.warn('[render] temp file cleanup failed:', e));
    await updateJob(renderId, {
      status: 'done',
      progress: 1,
      output_url: outputUrl,
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
