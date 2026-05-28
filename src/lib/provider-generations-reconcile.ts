/**
 * Reconciliation logic for `provider_generations` rows that landed at
 * the provider but never reached a user-visible `project_assets` row.
 *
 * Phase 2.2 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md).
 *
 * The bug class:
 *   Even with Phase 1.2's outbox in place, persistence can still fail
 *   in edge cases the outbox can't recover (Safari Private Mode
 *   evicting IDB, user clears site data, dead-after-MAX_ATTEMPTS
 *   entries). When that happens the server has a `delivered`
 *   provider_generations row (charge was issued, URL was returned)
 *   but no project_assets row — so the user paid for an image they
 *   never see. The outbox prevents most cases; this reconciliation
 *   catches the residual.
 *
 * Strategy (per the council's "auto-retry first, refund only if retry
 * fails" verdict):
 *
 *   1. Find candidate rows older than RECONCILE_AGE_MS (default 1h)
 *      with status='delivered', a response_url, and the project_id
 *      / row_index / slot needed to attempt recovery.
 *   2. For each candidate: check whether a matching project_assets
 *      row exists. If yes, just transition status to 'attached'
 *      (the client's attach POST succeeded, we just don't have the
 *      back-reference). If no, attempt to insert the project_assets
 *      row using the stored response_url.
 *   3. Successful insert → status='recovered'. Failed insert (FK
 *      violation = project deleted; slot unsupported = clip without
 *      metadata; etc.) → status='refund_pending'. A separate manual
 *      / billing process handles refund_pending rows; this cron does
 *      not issue refunds directly.
 *
 * What is NOT auto-recovered (always marks refund_pending):
 *   - clip slot — the project_assets entry needs `brollClipId` +
 *     `durationSeconds` that aren't in provider_generations.
 *   - thumbnail slot — no project_assets representation (thumbnails
 *     live in user_history.payload directly).
 *   - null slot / null project_id / null row_index — caller didn't
 *     have enough context to identify the attach target.
 *
 * Safety:
 *   - Idempotent: each candidate transitions via `UPDATE ... WHERE
 *     status = 'delivered'` so a re-run after partial completion
 *     skips already-handled rows.
 *   - Bounded: the candidate query has a LIMIT so a one-off catastrophic
 *     leak doesn't blow up a single cron tick. The query re-evaluates
 *     on the next tick.
 *   - Per-row try/catch: one bad row doesn't poison the whole batch.
 */
import { sql } from '@/lib/db';
import { logger } from './logger';
import { writeProjectAsset } from './project/assets';

/** Minimum age of a 'delivered' row before it's considered an orphan
 *  candidate. Anything fresher might still be in the client's outbox
 *  about to attach. 1 hour is generous — the outbox's max backoff is
 *  60s × 10 attempts = ~10 min. */
const RECONCILE_AGE_MS = 60 * 60 * 1000;

/** Max candidates per cron tick. Keeps the batch bounded; the cron
 *  fires hourly so even a 1000-row leak heals in a couple of ticks. */
const RECONCILE_BATCH_LIMIT = 500;

export interface ReconcileResult {
  candidates: number;
  alreadyAttached: number;
  recovered: number;
  refundPending: number;
  errors: number;
  durationMs: number;
}

interface CandidateRow {
  id: string;
  project_id: string | null;
  row_index: number | null;
  slot: string | null;
  response_url: string | null;
}

interface AttachedCheckRow {
  data: unknown;
}

export async function reconcileOrphanGenerations(): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const sinceIso = new Date(Date.now() - RECONCILE_AGE_MS).toISOString();

  logger.info('[reconcile orphan-generations] start', { since_iso: sinceIso });

  // Pull the candidate batch. The partial index on
  // (status, updated_at) WHERE status IN ('delivered', 'refund_pending')
  // makes this scan tiny — see migration 0100's index rationale.
  let candidates: CandidateRow[];
  try {
    const result = await sql<CandidateRow>`
      SELECT id, project_id, row_index, slot, response_url
        FROM provider_generations
       WHERE status = 'delivered'
         AND updated_at < ${sinceIso}::timestamptz
       ORDER BY updated_at ASC
       LIMIT ${RECONCILE_BATCH_LIMIT}
    `;
    candidates = result.rows;
  } catch (err) {
    logger.error('[reconcile orphan-generations] candidate query failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      candidates: 0,
      alreadyAttached: 0,
      recovered: 0,
      refundPending: 0,
      errors: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  let alreadyAttached = 0;
  let recovered = 0;
  let refundPending = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      const outcome = await reconcileOne(row);
      if (outcome === 'already-attached') alreadyAttached += 1;
      else if (outcome === 'recovered') recovered += 1;
      else refundPending += 1;
    } catch (err) {
      errors += 1;
      logger.error('[reconcile orphan-generations] row failed', {
        id: row.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const out: ReconcileResult = {
    candidates: candidates.length,
    alreadyAttached,
    recovered,
    refundPending,
    errors,
    durationMs: Date.now() - startedAt,
  };
  logger.info('[reconcile orphan-generations] done', { ...out });
  return out;
}

/** Per-row reconciliation. Pure-ish — only side effects are SQL
 *  writes (status transitions, project_assets inserts) and log lines. */
async function reconcileOne(
  row: CandidateRow,
): Promise<'already-attached' | 'recovered' | 'refund-pending'> {
  // Slots we can never auto-recover. Skip the project_assets check
  // entirely — go straight to refund_pending.
  if (!row.project_id || row.row_index === null || !row.slot || !row.response_url) {
    await markRefundPending(row.id, 'missing-context');
    return 'refund-pending';
  }
  if (row.slot !== 'image' && row.slot !== 'overlay') {
    // clip needs brollClipId / durationSeconds; thumbnail has no
    // project_assets row; anything else unknown. Refund queue.
    await markRefundPending(row.id, `slot-not-recoverable:${row.slot}`);
    return 'refund-pending';
  }

  // Check whether a matching project_assets row exists. Match on
  // (project_id, row_index, slot) — if there's a row at all, the
  // client's attach POST succeeded (or another row-asset write
  // clobbered it; either way we don't owe a recovery, just a status
  // transition).
  const existing = await sql<AttachedCheckRow>`
    SELECT data
      FROM project_assets
     WHERE project_id = ${row.project_id}::uuid
       AND row_index = ${row.row_index}
       AND slot = ${row.slot}
     LIMIT 1
  `;
  if (existing.rows.length > 0) {
    await markAttached(row.id);
    return 'already-attached';
  }

  // No project_assets row. Attempt recovery using the stored
  // response_url. Synthesise the slot-appropriate value shape (image
  // is a bare URL; overlay is { status: 'done', url }).
  try {
    if (row.slot === 'image') {
      await writeProjectAsset(row.project_id, row.row_index, 'image', row.response_url);
    } else if (row.slot === 'overlay') {
      await writeProjectAsset(row.project_id, row.row_index, 'overlay', {
        status: 'done',
        url: row.response_url,
      });
    }
    await markRecovered(row.id);
    logger.info('[reconcile recovered]', {
      id: row.id,
      project_id: row.project_id,
      row_index: row.row_index,
      slot: row.slot,
    });
    return 'recovered';
  } catch (err) {
    // FK violation = project deleted; constraint = data shape; etc.
    // The row stays auditable; mark refund_pending so the billing
    // workflow picks it up.
    await markRefundPending(
      row.id,
      `write-failed:${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
    );
    return 'refund-pending';
  }
}

async function markAttached(id: string): Promise<void> {
  await sql`
    UPDATE provider_generations
       SET status = 'attached',
           attached_at = NOW(),
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status = 'delivered'
  `;
}

async function markRecovered(id: string): Promise<void> {
  await sql`
    UPDATE provider_generations
       SET status = 'recovered',
           attached_at = NOW(),
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status = 'delivered'
  `;
}

async function markRefundPending(id: string, reason: string): Promise<void> {
  await sql`
    UPDATE provider_generations
       SET status = 'refund_pending',
           failure_reason = ${reason},
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status = 'delivered'
  `;
}
