import type { Migration } from './types';

/**
 * Lock down `saved_channel_names` with workspace scoping.
 *
 * Background: this table is listed in ROOT_TENANT_TABLES, so migration
 * 0011 SHOULD have added a nullable workspace_id and 0012 SHOULD have
 * backfilled it. But the table is created LAZILY by
 * `ensureChannelNamesSchema()` on first /channel-naming hit — on any
 * deployment where the user added saved names AFTER 0011-0013 ran (i.e.
 * after the table existed but had no workspace_id concept), the column
 * is missing entirely. The `saved_channel_names` route had ZERO auth
 * and read/wrote workspace-blind, so every workspace shared the same
 * pool of saved names — a cross-tenant leak.
 *
 * What this migration does:
 *   1. Defensively `ADD COLUMN IF NOT EXISTS workspace_id` — no-op when
 *      0011 already added it.
 *   2. Backfills any NULL workspace_id to the bootstrap workspace
 *      (same posture as 0012's final sweep — pre-multi-tenancy rows
 *      belong to the bootstrap tenant by definition).
 *   3. Replaces the global `UNIQUE (handle)` with a composite
 *      `UNIQUE (workspace_id, handle)`. Without this swap, the existing
 *      `ON CONFLICT (handle) DO UPDATE` in the save route would silently
 *      overwrite another workspace's row when two workspaces happen to
 *      pick the same handle — a cross-tenant WRITE leak. The composite
 *      key lets each workspace own its own "myname" entry.
 *   4. Adds a composite index for the GET path
 *      (`WHERE workspace_id = X ORDER BY saved_at DESC`).
 *
 * Deliberately NOT enforcing NOT NULL on workspace_id:
 *   - 0013 enforced NOT NULL on tables present at that time. For
 *     deployments where this table missed that pass, adding NOT NULL
 *     here would break a hot-deploy race (migration runs first, then
 *     an in-flight INSERT from the OLD app code lands without a
 *     workspace_id and trips the constraint).
 *   - The app layer (now wrapped in apiRoute.authed) is the source of
 *     truth: every INSERT must carry session.ws. NULL stays as a
 *     belt-and-suspenders fallback that becomes invisible to every
 *     workspace's GET query, never as the happy path.
 */
const migration: Migration = {
  id: '0077_saved_channel_names_workspace_scope',
  description: 'Add workspace_id to saved_channel_names (defensive), backfill to bootstrap, add composite index',

  async up(client) {
    // Skip cleanly if the table was never lazily created on this DB
    // (no user ever opened /channel-naming).
    const { rows: tableRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'saved_channel_names'
       ) AS exists`,
    );
    if (!tableRows[0]?.exists) return;

    await client.query(`
      ALTER TABLE saved_channel_names
        ADD COLUMN IF NOT EXISTS workspace_id UUID
        REFERENCES workspaces(id) ON DELETE CASCADE
    `);

    // Resolve bootstrap workspace (oldest by created_at, same rule as 0012).
    const { rows: wsRows } = await client.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const bootstrapId = wsRows[0]?.id;
    // Backfill is best-effort: on a fresh DB with no workspaces yet (should
    // not happen — 0005 bootstraps one — but stays defensive), the legacy
    // rows simply remain NULL and become invisible to every authed read.
    if (bootstrapId) {
      await client.query(
        `UPDATE saved_channel_names
            SET workspace_id = $1
          WHERE workspace_id IS NULL`,
        [bootstrapId],
      );
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_saved_names_workspace_saved_at
        ON saved_channel_names (workspace_id, saved_at DESC)
    `);

    // Swap the global UNIQUE(handle) for a workspace-scoped one. Safe to
    // do unconditionally because backfill above leaves every legacy row
    // attributed to a single workspace (bootstrap), so no duplicate
    // (workspace_id, handle) pairs can exist at this point.
    // The legacy constraint name comes from ensureChannelNamesSchema.
    await client.query(`
      ALTER TABLE saved_channel_names
        DROP CONSTRAINT IF EXISTS saved_channel_names_handle_unique
    `);
    // Postgres auto-derives a name for the new UNIQUE if we don't
    // provide one, but naming it explicitly keeps reheal scripts simple.
    await client.query(`
      ALTER TABLE saved_channel_names
        DROP CONSTRAINT IF EXISTS saved_channel_names_workspace_handle_unique
    `);
    await client.query(`
      ALTER TABLE saved_channel_names
        ADD CONSTRAINT saved_channel_names_workspace_handle_unique
        UNIQUE (workspace_id, handle)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_saved_names_workspace_saved_at`);
    // Deliberately do NOT drop workspace_id — that would re-open the
    // cross-tenant leak. Removing the index is reversible; removing the
    // tenancy column is not.
  },
};

export default migration;
