import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * Public anonymous-telemetry endpoint that the ReviewPlayer cold-start
 * instrumentation posts to once per video load. Drives the Phase 2 HLS
 * greenlight/skip decision (`_plans/2026-05-14-review-timing-aggregation.md`).
 *
 * Public on purpose: token-side reviewers don't have a session, and
 * gating this behind auth would silently drop the data we actually need
 * (real reviewer networks, not just owner laptops). Compensating
 * controls: tight per-IP rate limit, strict input validation, no PII
 * captured, no request-body logging.
 */

// Plausible upper bound on any cold-start metric. Anything above this is
// either clock skew, a runaway tab that was background-throttled for
// minutes, or a bad actor padding values to skew percentiles — exclude
// it at the boundary so the aggregate query can stay trivial.
const MAX_TIMING_MS = 600_000;

// One sample per cold-start per reviewer. 30/min/IP is far above any
// realistic legitimate cadence (no one mounts a fresh player 30 times a
// minute) and still caps a misbehaving client to ~43k rows/day.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IncomingSample {
  versionId: unknown;
  wasOwner: unknown;
  timeToMetadataMs: unknown;
  timeToFirstFrameMs: unknown;
  timeToCanPlayThroughMs: unknown;
  stallCount: unknown;
  totalStallMs: unknown;
}

interface ValidatedSample {
  versionId: string;
  wasOwner: boolean;
  timeToMetadataMs: number | null;
  timeToFirstFrameMs: number | null;
  timeToCanPlayThroughMs: number | null;
  stallCount: number;
  totalStallMs: number;
}

function validateTiming(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
  // Allow 0; reject negatives and absurd futures.
  if (value < 0 || value > MAX_TIMING_MS) return { ok: false };
  return { ok: true, value: Math.round(value) };
}

function validateBody(raw: unknown): { ok: true; value: ValidatedSample } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'body must be an object' };
  const s = raw as IncomingSample;

  if (typeof s.versionId !== 'string' || !UUID_RE.test(s.versionId)) {
    return { ok: false, reason: 'invalid versionId' };
  }
  if (typeof s.wasOwner !== 'boolean') {
    return { ok: false, reason: 'invalid wasOwner' };
  }

  const ttm = validateTiming(s.timeToMetadataMs);
  if (!ttm.ok) return { ok: false, reason: 'invalid timeToMetadataMs' };
  const ttff = validateTiming(s.timeToFirstFrameMs);
  if (!ttff.ok) return { ok: false, reason: 'invalid timeToFirstFrameMs' };
  const tcpt = validateTiming(s.timeToCanPlayThroughMs);
  if (!tcpt.ok) return { ok: false, reason: 'invalid timeToCanPlayThroughMs' };

  if (typeof s.stallCount !== 'number' || !Number.isFinite(s.stallCount) || s.stallCount < 0) {
    return { ok: false, reason: 'invalid stallCount' };
  }
  if (typeof s.totalStallMs !== 'number' || !Number.isFinite(s.totalStallMs) || s.totalStallMs < 0 || s.totalStallMs > MAX_TIMING_MS) {
    return { ok: false, reason: 'invalid totalStallMs' };
  }

  return {
    ok: true,
    value: {
      versionId: s.versionId,
      wasOwner: s.wasOwner,
      timeToMetadataMs: ttm.value,
      timeToFirstFrameMs: ttff.value,
      timeToCanPlayThroughMs: tcpt.value,
      // SMALLINT column tops at 255 for our purposes; a runaway counter
      // gets clamped rather than rejected so we don't drop the rest of a
      // legitimate-looking sample.
      stallCount: Math.min(255, Math.round(s.stallCount)),
      totalStallMs: Math.round(s.totalStallMs),
    },
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const { limited } = checkRateLimit(`review-timing:${getClientIP(req)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  // sendBeacon serialises as text/plain by default; accept either. Both
  // are parsed as JSON. We don't trust the Content-Type header to gate
  // anything because the validator below rejects non-JSON shapes anyway.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = validateBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }
  const s = parsed.value;

  try {
    await sql`
      INSERT INTO review_player_timing_samples (
        version_id, was_owner,
        time_to_metadata_ms, time_to_first_frame_ms, time_to_canplaythrough_ms,
        stall_count, total_stall_ms
      ) VALUES (
        ${s.versionId}, ${s.wasOwner},
        ${s.timeToMetadataMs}, ${s.timeToFirstFrameMs}, ${s.timeToCanPlayThroughMs},
        ${s.stallCount}, ${s.totalStallMs}
      )
    `;
  } catch (err) {
    // Deliberately do NOT echo the sample body into the log line — that
    // would defeat the no-PII promise the table makes (samples are
    // anonymous, but log aggregators are often searchable).
    logger.warn('review-timing: insert failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Write failed' }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
