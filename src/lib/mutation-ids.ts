/**
 * Server-side dedup helper for client-generated mutation intent ids.
 *
 * Phase 1.2 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md). Pairs with the
 * client-side `mutate()` chokepoint in `src/lib/mutate.ts`, which
 * attaches the `X-Intent-Id` header on every retry.
 *
 * Usage in a mutation route:
 *
 *   const dedup = await tryClaimIntent(req, session.uid, 'row-asset.set');
 *   if (dedup === 'duplicate') {
 *     return NextResponse.json({ ok: true, deduped: true });
 *   }
 *   if (dedup === 'kind-mismatch') {
 *     return NextResponse.json({ error: 'Intent id reused with wrong kind' }, { status: 409 });
 *   }
 *   // dedup === 'claimed' → proceed with the side effect
 *
 * Why a helper and not inline SQL at every route:
 *   1. The kind-mismatch check is non-obvious (insert OR ignore, then
 *      conditional re-read). Easy to skip and reintroduce the
 *      replay-attack surface. One place = one review.
 *   2. The "no X-Intent-Id header" path needs uniform treatment —
 *      Phase 1.0 routes called without the header should still
 *      execute (back-compat), Phase 1.2+ routes always have it.
 *   3. Centralised log lines (`[mutation-ids claim]` / `[mutation-ids
 *      duplicate]`) feed Sentry breadcrumbs uniformly.
 */
import { sql } from '@/lib/db';
import { logger } from './logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IntentClaimResult = 'no-intent' | 'claimed' | 'duplicate' | 'kind-mismatch';

/**
 * Try to claim a mutation intent id. Returns:
 *
 *   - 'no-intent'      — no X-Intent-Id header present. Caller should
 *                        proceed (legacy / direct-fetch caller).
 *   - 'claimed'        — first time we've seen this id. Caller must
 *                        proceed with the side effect.
 *   - 'duplicate'      — id already claimed with the same kind. The
 *                        side effect already ran (or is running in
 *                        another request). Caller should return a
 *                        success response WITHOUT re-running.
 *   - 'kind-mismatch'  — id already claimed with a DIFFERENT kind.
 *                        Either a client bug or an attempted replay
 *                        attack. Caller should return 409.
 *
 * Implementation:
 *   INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id  — gives us
 *   a row only on a fresh claim. On duplicate, the second SELECT
 *   reads the existing `kind` and compares. Two round-trips on the
 *   duplicate path is acceptable (it's the slow path).
 */
export async function tryClaimIntent(
  req: Request,
  userId: string,
  kind: string,
): Promise<IntentClaimResult> {
  const intentId = req.headers.get('x-intent-id');
  if (!intentId) return 'no-intent';
  if (!UUID_RE.test(intentId)) {
    logger.warn('[mutation-ids invalid-id]', { intentId: intentId.slice(0, 80), kind });
    return 'no-intent'; // treat as legacy — don't 4xx, the body might still be valid
  }

  try {
    const insertRes = await sql<{ id: string }>`
      INSERT INTO mutation_ids (id, kind, user_id)
      VALUES (${intentId}::uuid, ${kind}, ${userId}::uuid)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (insertRes.rows.length > 0) {
      logger.info('[mutation-ids claim]', { intentId, kind, userId });
      return 'claimed';
    }
    // Conflict — read the existing kind to distinguish legitimate
    // retry from id-reuse-with-different-kind.
    const existing = await sql<{ kind: string }>`
      SELECT kind FROM mutation_ids WHERE id = ${intentId}::uuid LIMIT 1
    `;
    const existingKind = existing.rows[0]?.kind;
    if (existingKind === kind) {
      logger.info('[mutation-ids duplicate]', { intentId, kind });
      return 'duplicate';
    }
    logger.warn('[mutation-ids kind-mismatch]', { intentId, claimedKind: kind, existingKind });
    return 'kind-mismatch';
  } catch (err) {
    // DB error during dedup — fail OPEN (proceed with the side effect)
    // rather than blocking the user's action on a logging-only table.
    // Worst case: duplicate side effect; the user notices and we
    // refund / dedupe in reconciliation. Failing CLOSED would block
    // every mutation on a transient pg blip, which is worse.
    logger.warn('[mutation-ids claim-failed-failing-open]', {
      intentId,
      kind,
      detail: err instanceof Error ? err.message : String(err),
    });
    return 'no-intent';
  }
}
