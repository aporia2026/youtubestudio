import type { Migration } from './types';

/**
 * Server-side ledger of every paid AI-provider generation: Kie / Atlas /
 * Replicate / OpenAI image and i2i calls. Captured BEFORE the provider
 * is invoked so a charge always has a server record, regardless of
 * whether the client succeeds in attaching the resulting URL to a
 * `project_assets` row afterwards.
 *
 * Why this exists (2026-05-29):
 *   The persistence audit on 2026-05-29 confirmed every paid generation
 *   route currently charges the provider BEFORE writing any server-side
 *   record. The flow is: server calls provider (MONEY SPENT) → returns
 *   URL to client → client POSTs URL to /row-asset (MAY FAIL → MONEY
 *   LOST). On a client-side failure the provider charge is unrecoverable
 *   and untraceable — no row anywhere captures the provider's request_id
 *   or the user's intent. Confirmed losses include doc d244130f-bdfe
 *   (181 rows saved, every image attach lost) explicitly called out in
 *   the row-asset endpoint comments.
 *
 *   This table is the foundation of the persistence-rebuild plan
 *   (_plans/2026-05-29-persistence-rebuild.md): every paid route INSERTs
 *   a 'pending' row here BEFORE the provider call, UPDATEs it on
 *   completion, and a nightly reconciliation cron joins this table
 *   against `project_assets` to recover (auto-retry first, refund only
 *   if retry fails) orphaned charges.
 *
 * Schema choices:
 *
 *   - `client_intent_id` is nullable in Phase 1.0 because the client
 *     does not yet send `X-Intent-Id` headers; Phase 1.2 (mutate()
 *     chokepoint) will populate it. UNIQUE WHERE NOT NULL via a partial
 *     index — duplicates from a client retry land in the same row, so
 *     server-side idempotency is enforced as soon as the client starts
 *     sending the header.
 *
 *   - `user_id` and `workspace_id` are FK'd with ON DELETE SET NULL,
 *     not CASCADE: a deleted user / workspace should NOT take the
 *     spend audit log with it. We need to keep these rows for billing
 *     reconciliation and the refund queue even after account closure.
 *
 *   - No FK on `project_id` and `row_index`. A generation may originate
 *     without a project (thumbnail experiments, ad-hoc test calls); the
 *     route knows what to record at intent time. Storing them as plain
 *     columns keeps the reconciliation join simple without forcing a
 *     not-null contract that the API would violate for legitimate
 *     non-project flows.
 *
 *   - `provider_request_id` (Kie taskId, Replicate prediction.id, Atlas
 *     UUID) is the bridge to the provider's billing system. Stored on
 *     UPDATE after the provider responds; nullable because some
 *     providers don't expose one and a synchronous failure has no id.
 *
 *   - `response_url` and `cost_usd` are stored at delivery time. The
 *     reconciliation job joins on `response_url` against
 *     `project_assets.data` (or `data->>url` for overlay/clip slots)
 *     to find orphans — string matching is brittle but acceptable
 *     until Phase 1.2 wires `client_intent_id` through to the row-asset
 *     POST and the reconciliation switches to id-based matching.
 *
 *   - `status` enum captures the full lifecycle:
 *       pending          → INSERTed before provider call
 *       delivered        → provider returned a URL successfully
 *       attached         → /row-asset POST confirmed (Phase 1.2)
 *       failed           → provider threw; no charge or charge refunded
 *       refund_pending   → reconciliation found delivered-but-orphan,
 *                          retry failed
 *       recovered        → reconciliation re-created project_assets row
 *                          from the stored response_url
 *       refunded         → terminal: user has been credited / refunded
 *
 *   - `failure_reason` is human-readable, capped at the application
 *     layer to ~400 chars before insert.
 *
 * Indexes:
 *
 *   - `(status, updated_at)` partial on the two states the reconciliation
 *     cron scans (`delivered`, `refund_pending`). Keeps the index small;
 *     attached/recovered/refunded rows don't bloat the scan.
 *
 *   - `(client_intent_id)` UNIQUE partial WHERE NOT NULL. Server-side
 *     idempotency once Phase 1.2 ships. Partial because Phase 1.0 rows
 *     have NULL intent_ids and we cannot enforce unique-with-null on a
 *     plain UNIQUE index in Postgres.
 *
 *   - `(user_id, created_at DESC)` for per-user audit queries (admin
 *     diagnostics page) and the "what did this user spend this month"
 *     read pattern.
 *
 *   - `(provider, provider_request_id)` for the reverse lookup: "the
 *     provider's webhook says request X failed, find our row." Partial
 *     WHERE provider_request_id IS NOT NULL.
 *
 * Retention: indefinite. Same justification as generation_events
 * (migration 0083) — small table, high audit value, easy to prune later
 * if growth becomes an issue.
 */
const migration: Migration = {
  id: '0100_create_provider_generations',
  description: 'Server-side ledger of paid AI-provider generations for orphan reconciliation and idempotency',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_generations (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_intent_id    UUID,
        user_id             UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        workspace_id        UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        project_id          UUID,
        row_index           INTEGER,
        slot                TEXT,
        route               TEXT NOT NULL,
        provider            TEXT NOT NULL,
        provider_model      TEXT,
        provider_request_id TEXT,
        response_url        TEXT,
        cost_usd            NUMERIC(10, 6),
        duration_ms         INTEGER,
        status              TEXT NOT NULL DEFAULT 'pending',
        failure_reason      TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attached_at         TIMESTAMPTZ,

        CONSTRAINT provider_generations_status_chk
          CHECK (status IN (
            'pending', 'delivered', 'attached',
            'failed', 'refund_pending', 'recovered', 'refunded'
          )),
        CONSTRAINT provider_generations_slot_chk
          CHECK (slot IS NULL OR slot IN ('image', 'overlay', 'clip', 'thumbnail')),
        CONSTRAINT provider_generations_row_index_chk
          CHECK (row_index IS NULL OR row_index >= 0)
      )
    `);

    // Reconciliation hot path: scan rows that may be orphans. Partial
    // index keeps the working set tiny — attached/recovered/refunded
    // rows are never scanned by the cron.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_provider_generations_reconcile
        ON provider_generations(status, updated_at)
        WHERE status IN ('delivered', 'refund_pending')
    `);

    // Server-side idempotency for client-driven retries. Partial unique
    // because Phase 1.0 rows have client_intent_id = NULL and Postgres
    // would otherwise treat each NULL as distinct (correct) but we want
    // to defer enforcement until Phase 1.2 populates it.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_generations_client_intent
        ON provider_generations(client_intent_id)
        WHERE client_intent_id IS NOT NULL
    `);

    // Per-user audit / cost rollup.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_provider_generations_user_created
        ON provider_generations(user_id, created_at DESC)
    `);

    // Reverse lookup from a provider's webhook or support ticket back
    // to our row. Partial WHERE NOT NULL because Phase 1.0 may store
    // NULL for providers that return synchronously without an id.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_provider_generations_provider_request
        ON provider_generations(provider, provider_request_id)
        WHERE provider_request_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_provider_generations_provider_request`);
    await client.query(`DROP INDEX IF EXISTS idx_provider_generations_user_created`);
    await client.query(`DROP INDEX IF EXISTS idx_provider_generations_client_intent`);
    await client.query(`DROP INDEX IF EXISTS idx_provider_generations_reconcile`);
    await client.query(`DROP TABLE IF EXISTS provider_generations`);
  },
};

export default migration;
