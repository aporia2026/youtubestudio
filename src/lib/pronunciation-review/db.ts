/**
 * DB helpers for the pronunciation review pipeline.
 *
 * Mirrors the shape of the forced-alignment helpers in
 * `src/lib/narrator-db.ts` (`claimTakeAlignment`,
 * `setTakeAlignmentReady`, `setTakeAlignmentFailed`,
 * `cancelTakeAlignment`, …) so the orchestrator in `./run.ts` reads like
 * the existing `runAlignmentForAssignment` and there's only one mental
 * model to maintain.
 *
 * Phase 1 surface: claim → store Whisper transcription → mark ready /
 * failed / cancelled. Phase 2 will add the per-flag write helpers
 * (`insertPronunciationFlags`, `updatePronunciationFlagStatus`, etc.)
 * once the candidate generation + Gemini judge is wired up.
 *
 * Status lifecycle is documented in migration 0107.
 *
 * Schema bootstrapping: this module does NOT call `ensureNarratorSchema`
 * — the migration system (migration 0107) is the source of truth. The
 * fact that narrator-db.ts re-creates tables on every read is a legacy
 * pattern; new code goes through migrations only.
 */

import { sql } from '@vercel/postgres';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PronunciationReviewStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** Subset of `narrator_takes` columns the orchestrator + UI need. */
export interface PronunciationReviewTakeRow {
  take_id: string;
  r2_key: string | null;
  audio_url: string | null;
  duration_seconds: number | null;
  pronunciation_review_status: PronunciationReviewStatus;
  pronunciation_review_error: string | null;
  pronunciation_review_started_at: string | null;
  pronunciation_review_cost_usd: number | null;
  /** Cached Whisper output — populated after the Phase-1 transcription
   *  step so the Phase-2 judge can re-run without paying Whisper again. */
  pronunciation_review_whisper_json: unknown;
}

/**
 * Shape we persist into `pronunciation_review_whisper_json`. Subset of
 * OpenAI's `TranscriptionVerbose` — we only need the fields the judge
 * step and the diff algorithm will consume. Stored as the application-
 * level shape rather than passing the SDK type through so a future SDK
 * upgrade can't silently change the JSONB on disk.
 */
export interface WhisperTranscriptionCache {
  /** Full text — handy for logs + smoke tests. */
  text: string;
  /** Total recognized audio duration, seconds. */
  duration_seconds: number;
  /** Whisper's detected language code (e.g. 'en'). */
  language: string;
  /** Word-level timestamps. Each word has `text` (we rename Whisper's
   *  `word` field to `text` so it matches the AlignedWord shape used
   *  elsewhere in the codebase), plus `start_sec` / `end_sec`. */
  words: Array<{ text: string; start_sec: number; end_sec: number }>;
  /** OpenAI model id used (e.g. 'whisper-1'). Stored for cache
   *  invalidation if we switch models later. */
  model: string;
  /** Wall-clock cost we recorded for this transcription. Separately
   *  stored on the take row (`pronunciation_review_cost_usd`) — kept
   *  here too so the JSON is self-describing for offline analysis. */
  cost_usd: number;
  /** ISO timestamp when the transcription completed. */
  completed_at: string;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Look up the assignment's full-audio take with pronunciation-review
 * fields. Returns null when the assignment doesn't exist or has no full
 * audio yet — the route layer maps both to a 400 / 404 as appropriate.
 *
 * Workspace scoping is enforced by the route layer (which already
 * verifies the caller can access the assignment); this query intentionally
 * does NOT filter by workspace, so the orchestrator can be called from
 * the assignment-scoped context without re-threading workspace_id.
 */
export async function getFullAudioTakeWithPronunciationReview(
  assignmentId: string,
): Promise<PronunciationReviewTakeRow | null> {
  const { rows } = await sql`
    SELECT t.id AS take_id,
           t.r2_key,
           t.audio_url,
           t.duration_seconds,
           t.pronunciation_review_status,
           t.pronunciation_review_error,
           t.pronunciation_review_started_at,
           t.pronunciation_review_cost_usd,
           t.pronunciation_review_whisper_json
    FROM narrator_assignments a
    JOIN narrator_takes t ON t.id = a.full_audio_take_id
    WHERE a.id = ${assignmentId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    take_id: row.take_id as string,
    r2_key: (row.r2_key as string | null) ?? null,
    audio_url: (row.audio_url as string | null) ?? null,
    duration_seconds:
      row.duration_seconds == null ? null : Number(row.duration_seconds),
    pronunciation_review_status: row.pronunciation_review_status as PronunciationReviewStatus,
    pronunciation_review_error: (row.pronunciation_review_error as string | null) ?? null,
    pronunciation_review_started_at:
      (row.pronunciation_review_started_at as string | null) ?? null,
    pronunciation_review_cost_usd:
      row.pronunciation_review_cost_usd == null
        ? null
        : Number(row.pronunciation_review_cost_usd),
    pronunciation_review_whisper_json: row.pronunciation_review_whisper_json,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Atomic claim. Transitions the take to `running` only from terminal /
 * idle states OR from a stale `running` (>10 min — pronunciation review
 * runs longer than alignment because Whisper + parallel Gemini judges add
 * up to ~60 s for a 14-min file).
 *
 * Returns true if the calling worker now owns the run. Two browser tabs
 * racing the manual button will collapse to one execution because only
 * one UPDATE can match.
 */
export async function claimPronunciationReview(takeId: string): Promise<boolean> {
  const { rows } = await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'running',
        pronunciation_review_started_at = NOW(),
        pronunciation_review_error = NULL
    WHERE id = ${takeId}
      AND (
        pronunciation_review_status IN ('none', 'pending', 'failed', 'cancelled', 'ready')
        OR (
          pronunciation_review_status = 'running'
          AND (
            pronunciation_review_started_at IS NULL
            OR pronunciation_review_started_at < NOW() - INTERVAL '10 minutes'
          )
        )
      )
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Phase 1 terminal state: Whisper transcription persisted. Phase 2 will
 * extend this signature to also accept the generated flag rows and
 * insert them in the same transaction. For now `ready` means
 * "transcription is available for inspection in
 * `pronunciation_review_whisper_json`."
 *
 * Guarded by status='running' so a late-arriving result can't overwrite
 * a cancellation.
 */
export async function setPronunciationReviewWhisperReady(args: {
  takeId: string;
  whisperJson: WhisperTranscriptionCache;
  costUsd: number;
}): Promise<boolean> {
  const { rows } = await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'ready',
        pronunciation_review_whisper_json = ${JSON.stringify(args.whisperJson)}::jsonb,
        pronunciation_review_cost_usd = ${args.costUsd},
        pronunciation_review_error = NULL
    WHERE id = ${args.takeId}
      AND pronunciation_review_status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Record a user-facing failure reason. Truncated to keep error messages
 * compact in the DB and the UI. Guarded on running/pending so a stale
 * orchestrator error doesn't overwrite a cancel ('cancelled') or success
 * ('ready') that already landed.
 */
export async function setPronunciationReviewFailed(
  takeId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'failed',
        pronunciation_review_error = ${reason.slice(0, 500)}
    WHERE id = ${takeId}
      AND pronunciation_review_status IN ('pending', 'running')
  `;
}

/**
 * Reviewer-initiated cancel. The in-flight Whisper/Gemini fetches can't
 * be aborted across function instances, but the subsequent ready/failed
 * write is guarded by `status = 'running'` so a cancellation always
 * sticks.
 */
export async function cancelPronunciationReview(takeId: string): Promise<boolean> {
  const { rows } = await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'cancelled',
        pronunciation_review_error = 'Cancelled by user'
    WHERE id = ${takeId}
      AND pronunciation_review_status IN ('pending', 'running')
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Drop any cached pronunciation-review state so a fresh take upload
 * doesn't carry over flags from the previous take. Called from the
 * narrator-upload path when full_audio_take_id is updated. Does NOT
 * delete `pronunciation_flags` rows — those cascade via FK on
 * `narrator_takes(id)` when the prior take is removed; if the take row
 * survives, we keep the flag history for now (a future surface might
 * want to show the audit trail).
 */
export async function resetPronunciationReview(takeId: string): Promise<void> {
  await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'none',
        pronunciation_review_whisper_json = NULL,
        pronunciation_review_error = NULL,
        pronunciation_review_cost_usd = NULL,
        pronunciation_review_started_at = NULL
    WHERE id = ${takeId}
  `;
}

// ─── Budget ───────────────────────────────────────────────────────────────────

/**
 * Sum of all pronunciation-review costs in the current calendar month.
 * Used by the orchestrator's budget guard. Approximates the same way
 * `getCurrentMonthAlignmentSeconds` does — re-runs over the same take
 * stack up because we update the cost column in-place; that's
 * intentional, so the cap catches a runaway re-run loop.
 */
export async function getCurrentMonthPronunciationReviewCostUsd(): Promise<number> {
  const { rows } = await sql`
    SELECT COALESCE(SUM(pronunciation_review_cost_usd), 0) AS total
    FROM narrator_takes
    WHERE pronunciation_review_status = 'ready'
      AND pronunciation_review_started_at >= date_trunc('month', NOW())
  `;
  const total = rows[0]?.total;
  return total == null ? 0 : Number(total);
}
