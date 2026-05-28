import type { Migration } from './types';

/**
 * Server-side dedup table for client-generated mutation intent ids.
 *
 * Phase 1.2 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md) will introduce a
 * client-side `mutate()` chokepoint that attaches a UUIDv7
 * `X-Intent-Id` header to every server mutation. The chokepoint
 * retries on 5xx / network failure with backoff, which means a single
 * user action can produce multiple identical requests.
 *
 * Without server-side dedup, a retry that arrives after the original
 * already succeeded would write the same row twice (image generated
 * twice, charge twice, project_assets row inserted twice). With this
 * table, every mutation handler first INSERTs the intent id with
 * `ON CONFLICT (id) DO NOTHING`; if the conflict fires the handler
 * short-circuits and returns the cached / current result rather than
 * re-running the side effect.
 *
 * Schema choices:
 *
 *   - `id UUID PRIMARY KEY` — the intent id IS the primary key, so
 *     `ON CONFLICT (id) DO NOTHING` is a single index lookup. No
 *     surrogate key.
 *
 *   - `kind TEXT NOT NULL` — the mutation type ('row-asset.set',
 *     'user-settings.set', etc.). Stored for telemetry / debugging
 *     ("which kinds get retried most?") and to defend against an
 *     attacker reusing one user's intent id for a different mutation
 *     kind. The handler can assert (intent_id, kind) matches.
 *
 *   - `user_id UUID REFERENCES collaborators(id) ON DELETE CASCADE`
 *     — every mutation is attributable to a user. Cascade-delete so
 *     a removed account doesn't leave behind dedup keys that could
 *     resurrect under an id collision (negligible UUID risk, but the
 *     cascade also keeps the table from growing forever on inactive
 *     accounts).
 *
 *   - No `result` column. The handler's job is to perform the
 *     mutation and return the result; this table only proves
 *     "we already saw this id." If a caller needs the original
 *     response on a duplicate hit, they can re-query the affected
 *     entity (project_assets row, user_settings row, etc.) which is
 *     the same data anyway.
 *
 *   - `created_at TIMESTAMPTZ` — for a future retention sweep. The
 *     persistence-rebuild plan calls for pruning rows older than 30
 *     days (long enough that any in-flight client retry has either
 *     succeeded or aged out of the outbox). Not wired in this
 *     migration; a follow-up cron job handles the prune when the
 *     reconciliation job lands (Phase 2.2).
 *
 * Indexes:
 *
 *   - PK on `id` is sufficient for the dedup write path
 *     (`INSERT ... ON CONFLICT (id)`).
 *   - `(user_id, created_at DESC)` for the future retention sweep
 *     and for per-user telemetry queries ("how often did this user
 *     hit a duplicate this week?").
 *
 * Not in this migration (deferred to Phase 1.2 wiring):
 *   - No FK from `provider_generations.client_intent_id` to
 *     `mutation_ids.id`. The two tables capture overlapping but
 *     non-identical concepts — provider_generations rows exist only
 *     for paid generations, mutation_ids covers every mutation kind.
 *     Adding the FK would force every provider_generations row to
 *     have a matching mutation_ids row, which is wrong for the
 *     Phase 1.0 backfill window.
 */
const migration: Migration = {
  id: '0101_create_mutation_ids',
  description: 'Server-side dedup table for client mutation intent ids — backbone of Phase 1.2 outbox idempotency',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mutation_ids (
        id          UUID PRIMARY KEY,
        kind        TEXT NOT NULL,
        user_id     UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Per-user listing + retention sweep. DESC because the prune
    // query (`WHERE created_at < now() - interval '30 days'`) reads
    // the tail; same index serves both shapes.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mutation_ids_user_created
        ON mutation_ids(user_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_mutation_ids_user_created`);
    await client.query(`DROP TABLE IF EXISTS mutation_ids`);
  },
};

export default migration;
