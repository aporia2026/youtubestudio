/**
 * Voiceover alignment cache + provider-aware aligner orchestrator.
 *
 * Sits between the pure cursor walk in `voiceover-alignment.ts` and the
 * production-doc render path. Responsibilities:
 *
 *   1. Compute a deterministic cache key. For ElevenLabs (the historic
 *      default) the key shape is unchanged so existing cache rows still
 *      resolve. For Google (added 2026-05-25 in the TTS-dispatch
 *      migration) the key gets a `google` salt so the two providers'
 *      alignments never collide on the same audio URL.
 *   2. Look the key up in `voiceover_alignments`; on hit, return the
 *      stored alignment + `cached: true`.
 *   3. On miss, fetch the audio, dispatch through `tts/dispatch.align()`
 *      which routes to the right aligner (ElevenLabs Forced Alignment
 *      or Google Speech-to-Text), and persist the response.
 *   4. Enforce a per-day spend cap (env-configurable) so a runaway
 *      invalidation loop can't burn the budget. Cap covers BOTH
 *      providers — Google STT cost lands in the same `cost_usd`
 *      column.
 *
 * The cache is workspace-global on purpose — two workspaces aligning
 * the same audio + script get the same answer, and there's no reason
 * to duplicate the row. Workspace-level access control lives at the
 * route layer.
 *
 * Never throws past the caller's expectations: every failure mode
 * (no API key, audio fetch error, vendor 5xx, daily cap reached)
 * surfaces as a typed result so the production-doc page can render a
 * specific pill rather than a generic "something went wrong" toast.
 */

import { createHash } from 'crypto';
import { sql } from '@vercel/postgres';
import { buildCanonicalScript } from './voiceover-alignment';
import { logger } from './logger';
import { align as dispatchAlign } from './tts/dispatch';
import type { AlignResult, VoiceRef } from './tts/types';
import { TtsProviderError } from './tts/types';
import type { ForcedAlignmentResponse } from './elevenlabs';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Scribe STT pricing — verified at <https://elevenlabs.io/pricing> on 2026-05-13. */
const ELEVENLABS_SCRIBE_USD_PER_HOUR = 0.22;

/**
 * Per-day spend cap on aligner calls (both providers share the cap).
 * Default $2/day at Scribe pricing buys ~9 hours of audio alignment
 * — well above any legitimate daily usage; the cap exists to catch a
 * runaway cache invalidation loop. Override via
 * `ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY` (env name preserved from the
 * pre-dispatch era for compatibility with existing deploys).
 */
const DEFAULT_DAILY_BUDGET_USD = 2;

function getDailyBudgetUsd(): number {
  const raw = process.env.ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
}

/**
 * Default voice ref used when a caller doesn't supply one. Keeps
 * pre-dispatch callers (render route, smoke script) working without
 * change — alignment goes through the ElevenLabs path. New callers
 * (the /api/voiceovers/align route post-2026-05-25) look up the
 * media_assets row first and pass the actual provider's voice ref.
 */
const DEFAULT_ELEVENLABS_VOICE: VoiceRef = {
  providerId: 'elevenlabs',
  voiceId: 'unknown',
  languageCode: 'en-US',
  tier: 'multilingual-v2',
};

// ─── Cache key derivation ─────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Cache key = sha256(audioUrl) joined with sha256(canonicalScript) and
 * hashed again. For Google voiceovers a `google` salt is mixed in so
 * the same URL aligned with two different aligners produces two
 * distinct keys (this is mostly defensive — a Google R2 audio URL
 * shouldn't ever be claimed by ElevenLabs and vice versa, but the
 * salt makes that invariant cheap to enforce).
 *
 * Backward compatibility: the ElevenLabs branch produces the exact
 * same key shape as before the provider abstraction. Existing rows
 * continue to resolve without re-alignment.
 *
 * Exported for tests + so the production-doc page can pre-warm the
 * cache via `/api/voiceover/align` using the exact same key the render
 * path will compute later.
 */
export function deriveCacheKey(
  audioUrl: string,
  canonicalScript: string,
  voice: VoiceRef = DEFAULT_ELEVENLABS_VOICE,
): string {
  const urlHash = sha256Hex(audioUrl);
  const scriptHash = sha256Hex(canonicalScript);
  if (voice.providerId === 'elevenlabs') {
    return sha256Hex(`${urlHash}|${scriptHash}`);
  }
  return sha256Hex(`${urlHash}|${scriptHash}|${voice.providerId}`);
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
  /** Skip the cache read and always call the aligner. Used by the
   *  production-doc "Re-align" pill when the creator explicitly asks
   *  to invalidate. */
  forceRefresh?: boolean;
  /** Origin voice ref. When omitted, defaults to a synthetic
   *  ElevenLabs ref — preserves pre-dispatch behavior for callers
   *  that haven't migrated yet. New callers should pass the real
   *  VoiceRef looked up from `media_assets.metadata`. */
  voice?: VoiceRef;
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
  const voice = options.voice ?? DEFAULT_ELEVENLABS_VOICE;
  const cacheKey = deriveCacheKey(audioUrl, canonicalScript, voice);

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

  // Fetch the audio bytes server-side so the URL never leaks to the
  // aligner as a callback URL. Same SSRF posture as before.
  let audioBytes: Uint8Array;
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return {
        status: 'failed',
        reason: `Voiceover audio fetch failed (HTTP ${audioRes.status}).`,
        cacheKey,
      };
    }
    audioBytes = new Uint8Array(await audioRes.arrayBuffer());
  } catch (err) {
    return {
      status: 'failed',
      reason: `Voiceover audio fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      cacheKey,
    };
  }
  if (audioBytes.byteLength === 0) {
    return { status: 'failed', reason: 'Voiceover audio is empty.', cacheKey };
  }

  let alignResult: AlignResult;
  try {
    alignResult = await dispatchAlign({
      voice,
      audio: audioBytes,
      mimeType: 'audio/mpeg',
      text: canonicalScript,
      languageCode: voice.languageCode,
    });
  } catch (err) {
    // Dispatch layer surfaces TtsProviderError for vendor failures and
    // misconfiguration; everything else is a programming bug. Sanitise
    // the message before surfacing to callers / logs.
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240);
    logger.warn('voiceover-alignment-cache: align failed', {
      cacheKey,
      provider: voice.providerId,
      code: err instanceof TtsProviderError ? err.code : 'unknown',
      detail: safe,
    });
    return {
      status: 'failed',
      reason:
        voice.providerId === 'google'
          ? `Google STT alignment failed: ${safe}`
          : `ElevenLabs alignment failed: ${safe}`,
      cacheKey,
    };
  }

  // Persist in the legacy alignment_json shape: words: [{text, start, end}]
  // — same fields the renderer + existing cached rows expect.
  // `characters` is intentionally omitted: the dispatcher's AlignResult
  // is word-level only (Google STT doesn't return char-level), and the
  // downstream renderer + alignRowsToWords only consult `words`.
  const alignmentForCache: ForcedAlignmentResponse = {
    words: alignResult.words.map((w) => ({ text: w.text, start: w.startSec, end: w.endSec })),
  };

  const durationMs = Math.round(alignResult.durationSec * 1000);
  // Use the cost the aligner returned. For ElevenLabs that's still
  // proportional to spoken duration via ELEVENLABS_SCRIBE_USD_PER_HOUR
  // (the aligner module's own constant matches the one here — see
  // src/lib/tts/cost.ts).
  const cost = alignResult.costUsd;

  try {
    await writeCachedAlignment({
      cacheKey,
      alignment: alignmentForCache,
      durationMs,
      cost,
    });
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
    alignment: alignmentForCache,
    durationMs,
    cacheKey,
    cached: false,
    cost,
  };
}

// ─── Re-export for callers that build the cache key from rows ─────────────────

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

// Re-export for callers / tests that want the constant directly.
export { ELEVENLABS_SCRIBE_USD_PER_HOUR };
