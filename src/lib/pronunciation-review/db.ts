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
 * Phase 2 — just persists the Whisper transcription without flipping
 * to 'ready'. Called between the Whisper step and the judge step so
 * a downstream failure still preserves the transcription (re-runs
 * skip re-paying Whisper).
 *
 * Status stays at 'running' on success; the orchestrator's
 * `setPronunciationReviewReady` call flips it after the judge
 * completes. Guarded by status='running' so a cancel sticks.
 */
export async function setPronunciationReviewWhisperCache(args: {
  takeId: string;
  whisperJson: WhisperTranscriptionCache;
  costUsd: number;
}): Promise<boolean> {
  const { rows } = await sql`
    UPDATE narrator_takes
    SET pronunciation_review_whisper_json = ${JSON.stringify(args.whisperJson)}::jsonb,
        pronunciation_review_cost_usd = ${args.costUsd}
    WHERE id = ${args.takeId}
      AND pronunciation_review_status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Phase 2 terminal state. Flips status to 'ready' and rolls the
 * judge-step cost into `pronunciation_review_cost_usd` (which already
 * includes the Whisper cost from `setPronunciationReviewWhisperCache`).
 *
 * Guarded by status='running' so a cancellation that landed mid-judge
 * isn't overwritten. Returns false in that case; the caller should
 * leave the flag rows in place (the next re-run's DELETE pass will
 * clear them).
 */
export async function setPronunciationReviewReady(args: {
  takeId: string;
  /** Cost of the judge step only — added to the existing
   *  `pronunciation_review_cost_usd` value (Whisper cost). */
  judgeCostUsd: number;
}): Promise<boolean> {
  const { rows } = await sql`
    UPDATE narrator_takes
    SET pronunciation_review_status = 'ready',
        pronunciation_review_cost_usd =
          COALESCE(pronunciation_review_cost_usd, 0) + ${args.judgeCostUsd},
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

// ─── Flag rows ────────────────────────────────────────────────────────────────

export type FlagCategory =
  | 'script_deviation'
  | 'mispronunciation'
  | 'omission'
  | 'insertion';

export type FlagUserStatus = 'pending' | 'accepted' | 'dismissed';

export interface PronunciationFlagInsert {
  word_index: number;
  start_sec: number;
  end_sec: number;
  category: FlagCategory;
  confidence: number;
  ai_explanation: string;
  suggested_comment: string;
}

export interface PronunciationFlagRow extends PronunciationFlagInsert {
  id: string;
  take_id: string;
  workspace_id: string;
  user_status: FlagUserStatus;
  user_comment: string | null;
  comment_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Drop the take's `user_status='pending'` flags so a re-run can write
 * fresh judgements without duplicating rows. Preserves `accepted` and
 * `dismissed` flags — those carry decisions the reviewer already made
 * and re-surfacing them would force them to re-decide.
 *
 * Returns the count of deleted rows so the orchestrator can log how
 * much state churned.
 */
export async function deletePendingPronunciationFlags(
  takeId: string,
): Promise<number> {
  const { rowCount } = await sql`
    DELETE FROM pronunciation_flags
    WHERE take_id = ${takeId}
      AND user_status = 'pending'
  `;
  return rowCount ?? 0;
}

/**
 * Insert a batch of pronunciation flags for a single take. Workspace
 * id is required for tenancy enforcement (`pronunciation_flags` has
 * `workspace_id NOT NULL`); the caller looks it up from the take's
 * assignment once and passes it through.
 *
 * Inserts are performed sequentially in a loop rather than via a
 * multi-row INSERT — keeps the SQL simple and the per-row cost is
 * negligible against the Gemini-judge latency that just preceded
 * this. If row counts ever grow past ~100 per take we can switch to
 * `INSERT ... VALUES (..), (..), ...` for a one-trip insert.
 *
 * Returns the inserted ids in input order so the route can echo them
 * to the client without an additional read.
 */
export async function insertPronunciationFlags(args: {
  takeId: string;
  workspaceId: string;
  flags: ReadonlyArray<PronunciationFlagInsert>;
}): Promise<string[]> {
  const ids: string[] = [];
  for (const f of args.flags) {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO pronunciation_flags (
        take_id, workspace_id,
        word_index, start_sec, end_sec,
        category, confidence,
        ai_explanation, suggested_comment
      ) VALUES (
        ${args.takeId}, ${args.workspaceId},
        ${f.word_index}, ${f.start_sec}, ${f.end_sec},
        ${f.category}, ${f.confidence},
        ${f.ai_explanation}, ${f.suggested_comment}
      )
      RETURNING id
    `;
    if (rows[0]?.id) ids.push(rows[0].id);
  }
  return ids;
}

/**
 * Read all flags for a take in chronological audio order. The UI
 * renders flags top-to-bottom by `start_sec`, and the inline
 * underlines snap to the same order. Returns an empty array when the
 * review hasn't run yet — callers branch on the take's
 * `pronunciation_review_status` for that signal.
 */
export async function listPronunciationFlagsForTake(
  takeId: string,
): Promise<PronunciationFlagRow[]> {
  const { rows } = await sql<PronunciationFlagRow>`
    SELECT id, take_id, workspace_id,
           word_index, start_sec, end_sec,
           category, confidence,
           ai_explanation, suggested_comment,
           user_status, user_comment, comment_id,
           created_at, updated_at
    FROM pronunciation_flags
    WHERE take_id = ${takeId}
    ORDER BY start_sec ASC
  `;
  return rows.map((r) => ({
    ...r,
    // sql returns numerics as strings — coerce so the UI doesn't have
    // to.
    start_sec: Number(r.start_sec),
    end_sec: Number(r.end_sec),
    confidence: Number(r.confidence),
    word_index: Number(r.word_index),
  }));
}

/**
 * Look up the workspace id for a take via its assignment. Needed when
 * the orchestrator inserts flag rows (`workspace_id NOT NULL`) — the
 * take itself doesn't carry workspace_id directly but the assignment
 * does (post-migration-0013).
 */
export async function getWorkspaceIdForAssignment(
  assignmentId: string,
): Promise<string | null> {
  const { rows } = await sql<{ workspace_id: string }>`
    SELECT workspace_id
    FROM narrator_assignments
    WHERE id = ${assignmentId}
    LIMIT 1
  `;
  return rows[0]?.workspace_id ?? null;
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
