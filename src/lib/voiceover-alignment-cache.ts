/**
 * Voiceover alignment cache + ElevenLabs orchestrator.
 *
 * This is the side-effecting layer that sits between the pure cursor
 * walk in `voiceover-alignment.ts` and the production-doc render path.
 * Responsibilities:
 *
 *   1. Compute a deterministic cache key for an audio URL + canonical
 *      script pair (sha256 of both, joined so neither alone can produce
 *      a collision).
 *   2. Look the key up in `voiceover_alignments`; on hit, return the
 *      stored alignment + a `cached: true` flag.
 *   3. On miss, fetch the audio, call ElevenLabs Forced Alignment, and
 *      persist the response.
 *   4. Enforce a per-day spend cap (env-configurable) so a runaway
 *      invalidation loop can't burn the budget.
 *
 * The cache is workspace-global on purpose — two workspaces aligning
 * the same audio + script get the same answer, and there's no reason
 * to duplicate the row. Workspace-level access control lives at the
 * route layer (`apiRoute.authed`).
 *
 * Never throws past the caller's expectations: every failure mode
 * (no API key, audio fetch error, ElevenLabs 5xx, daily cap reached)
 * surfaces as a typed result so the production-doc page can render a
 * specific pill rather than a generic "something went wrong" toast.
 */

import { createHash } from 'crypto';
import { sql } from '@vercel/postgres';
import { forceAlign, type ForcedAlignmentResponse } from './elevenlabs';
import { buildCanonicalScript } from './voiceover-alignment';
import { logger } from './logger';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Scribe STT pricing — verified at <https://elevenlabs.io/pricing> on 2026-05-13. */
const ELEVENLABS_SCRIBE_USD_PER_HOUR = 0.22;

/**
 * Per-day spend cap on Forced Alignment calls. Default $2/day at
 * Scribe pricing buys ~9 hours of audio alignment — well above any
 * legitimate daily usage; the cap exists to catch a runaway cache
 * invalidation loop. Override via `ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY`.
 */
const DEFAULT_DAILY_BUDGET_USD = 2;

function getDailyBudgetUsd(): number {
  const raw = process.env.ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
}

// ─── Cache key derivation ─────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Cache key = sha256(audioUrl) joined with sha256(canonicalScript) and
 * hashed again. Either input changing produces a different key, which
 * is exactly the invalidation contract:
 *   - same audio + same script → cache hit ($0)
 *   - same audio + edited script → miss, fresh alignment
 *   - same script + replaced audio → miss, fresh alignment
 *
 * Exported for tests + so the production-doc page can pre-warm the
 * cache via `/api/voiceover/align` using the exact same key the render
 * path will compute later.
 */
export function deriveCacheKey(audioUrl: string, canonicalScript: string): string {
  const urlHash = sha256Hex(audioUrl);
  const scriptHash = sha256Hex(canonicalScript);
  return sha256Hex(`${urlHash}|${scriptHash}`);
}

// ─── Result envelope ──────────────────────────────────────────────────────────

export type EnsureAlignmentResult =
  | {
      status: 'ready';
      alignment: ForcedAlignmentResponse;
      durationMs: number;
      cacheKey: string;
      cached: boolean;
      /** USD billed to today's cap. 0 on cache hit. */
      cost: number;
    }
  | {
      status: 'failed';
      reason: string;
      cacheKey: string;
    };

// ─── Public entry point ───────────────────────────────────────────────────────

export interface EnsureAlignmentOptions {
  /** Skip the cache read and always call ElevenLabs. Used by the
   *  production-doc "Re-align" pill when the creator explicitly asks
   *  to invalidate. */
  forceRefresh?: boolean;
}

/**
 * Top-level entry: given an audio URL and the canonical script, return
 * an alignment, hitting the cache when possible. The function NEVER
 * throws — callers branch on `result.status` and surface the failure
 * reason to the UI.
 */
export async function ensureAlignmentForVoiceover(
  audioUrl: string,
  canonicalScript: string,
  options: EnsureAlignmentOptions = {},
): Promise<EnsureAlignmentResult> {
  const cacheKey = deriveCacheKey(audioUrl, canonicalScript);

  if (!canonicalScript.trim()) {
    return { status: 'failed', reason: 'Script is empty — nothing to align.', cacheKey };
  }
  if (!/^https?:\/\//.test(audioUrl)) {
    return { status: 'failed', reason: 'Voiceover URL must be http(s).', cacheKey };
  }

  // Cache hit path — `forceRefresh` skips this so the route can
  // implement the "Re-align" affordance without exposing two helpers.
  if (!options.forceRefresh) {
    try {
      const hit = await readCachedAlignment(cacheKey);
      if (hit) {
        return {
          status: 'ready',
          alignment: hit.alignment,
          durationMs: hit.durationMs,
          cacheKey,
          cached: true,
          cost: 0,
        };
      }
    } catch (err) {
      // Read failure is non-fatal: fall through to a fresh alignment.
      logger.warn('voiceover-alignment-cache: read failed', {
        cacheKey,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      status: 'failed',
      reason: 'ElevenLabs API key is not configured on the server.',
      cacheKey,
    };
  }

  // Daily spend cap is checked BEFORE the audio fetch so the cap math
  // is paid per attempt (and a busted audio URL doesn't get a free
  // pass past the cap).
  const todaySpend = await getTodaySpendUsd().catch(() => 0);
  const dailyBudget = getDailyBudgetUsd();
  if (todaySpend >= dailyBudget) {
    return {
      status: 'failed',
      reason: `Daily alignment budget reached ($${dailyBudget.toFixed(2)}). Try again tomorrow or raise ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY.`,
      cacheKey,
    };
  }

  // Fetch the audio bytes server-side so the URL never leaks to
  // ElevenLabs as a callback URL. Same pattern as src/lib/alignment.ts.
  let audioBlob: Blob;
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return {
        status: 'failed',
        reason: `Voiceover audio fetch failed (HTTP ${audioRes.status}).`,
        cacheKey,
      };
    }
    audioBlob = await audioRes.blob();
  } catch (err) {
    return {
      status: 'failed',
      reason: `Voiceover audio fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      cacheKey,
    };
  }
  if (audioBlob.size === 0) {
    return { status: 'failed', reason: 'Voiceover audio is empty.', cacheKey };
  }

  let alignment: ForcedAlignmentResponse;
  try {
    alignment = await forceAlign(apiKey, {
      audioBlob,
      audioFilename: 'voiceover.mp3',
      text: canonicalScript,
    });
  } catch (err) {
    // `forceAlign` interpolates the response body into its error
    // message — sanitise before surfacing to callers / logs.
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240);
    logger.warn('voiceover-alignment-cache: forceAlign failed', { cacheKey, detail: safe });
    return { status: 'failed', reason: `ElevenLabs alignment failed: ${safe}`, cacheKey };
  }

  const durationMs = inferDurationMs(alignment);
  const cost = (durationMs / 1000 / 3600) * ELEVENLABS_SCRIBE_USD_PER_HOUR;

  try {
    await writeCachedAlignment({ cacheKey, alignment, durationMs, cost });
  } catch (err) {
    // Write failure is non-fatal: we have a usable alignment in memory
    // even if persisting it lost a race against another worker who
    // already inserted the same key. Log and continue.
    logger.warn('voiceover-alignment-cache: write failed', {
      cacheKey,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    status: 'ready',
    alignment,
    durationMs,
    cacheKey,
    cached: false,
    cost,
  };
}

// ─── Re-export for callers that build the cache key from rows ─────────────────

/**
 * Convenience: given per-row stripped scripts, compute the canonical
 * script the cache will see. The production-doc UI uses this to derive
 * the cache key client-side (no real "compute" cost on the wire — the
 * value is exactly what `buildCanonicalScript` produces).
 */
export { buildCanonicalScript };

// ─── DB helpers (kept private — go through `ensureAlignmentForVoiceover`) ─────

interface CacheRow {
  alignment_json: ForcedAlignmentResponse;
  duration_ms: number;
}

async function readCachedAlignment(
  cacheKey: string,
): Promise<{ alignment: ForcedAlignmentResponse; durationMs: number } | null> {
  const result = await sql<CacheRow>`
    SELECT alignment_json, duration_ms
    FROM voiceover_alignments
    WHERE cache_key = ${cacheKey}
    LIMIT 1
  `;
  if (result.rows.length === 0) return null;
  return {
    alignment: result.rows[0].alignment_json,
    durationMs: result.rows[0].duration_ms,
  };
}

async function writeCachedAlignment(args: {
  cacheKey: string;
  alignment: ForcedAlignmentResponse;
  durationMs: number;
  cost: number;
}): Promise<void> {
  // ON CONFLICT DO NOTHING is intentional: two workers racing on the
  // same key will both write the same alignment, and we don't want the
  // second one to throw. Whoever lost the race already has its
  // alignment in memory and returns ready.
  await sql`
    INSERT INTO voiceover_alignments (cache_key, alignment_json, duration_ms, cost_usd)
    VALUES (${args.cacheKey}, ${JSON.stringify(args.alignment)}::jsonb, ${args.durationMs}, ${args.cost})
    ON CONFLICT (cache_key) DO NOTHING
  `;
}

/**
 * Sum of today's `cost_usd` against the daily cap. UTC day boundary —
 * matches how `getCurrentMonthAlignmentSeconds` reasons about windows
 * in `src/lib/alignment.ts`, so the two caps don't disagree on what
 * "today" means.
 */
async function getTodaySpendUsd(): Promise<number> {
  const result = await sql<{ total: string | null }>`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total
    FROM voiceover_alignments
    WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
  `;
  const raw = result.rows[0]?.total ?? '0';
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Derive audio duration from the alignment response. The last spoken
 * word's `end` is the audio length in seconds (ElevenLabs aligns
 * exactly the supplied script, so trailing silence past the final
 * word is not represented in the response — `duration_ms` here is the
 * spoken duration, which is what the cost cap math wants).
 */
function inferDurationMs(alignment: ForcedAlignmentResponse): number {
  const words = alignment.words || [];
  let endSec = 0;
  for (const w of words) {
    if (typeof w.end === 'number' && w.end > endSec) endSec = w.end;
  }
  return Math.round(endSec * 1000);
}
