import type { Migration } from './types';

/**
 * Replace the legacy global `UNIQUE (channel_id)` on
 * `competitor_channels` with a workspace-scoped
 * `UNIQUE (workspace_id, channel_id)`. Mirrors what 0019 did for
 * `channels` and what 0036 did for `google_auth_tokens`.
 *
 * Why now (audit C2 + M11): the route at /api/competitors was
 * unauthenticated AND returned every workspace's competitors in one
 * query — a P0 cross-tenant data leak. Workspace-scoping the route
 * (separate commit) means two workspaces can now legitimately track
 * the same competitor channel. The legacy constraint would block
 * that with a duplicate-key error.
 *
 * Also adds an index on (workspace_id, created_at DESC) since the
 * primary read path is "competitors in this workspace, newest first".
 */
const migration: Migration = {
  id: '0038_competitor_channels_workspace_unique',
  description: 'Replace UNIQUE(channel_id) on competitor_channels with UNIQUE(workspace_id, channel_id)',

  async up(client) {
    // Drop the legacy constraint by its default Postgres name. If
    // someone renamed it manually, this is a no-op (IF EXISTS) and
    // the new constraint goes on top.
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        DROP CONSTRAINT IF EXISTS competitor_channels_channel_id_key
    `);
    // Belt-and-braces: drop any prior version of the new constraint
    // before adding it (so re-running on a partially-migrated DB is
    // idempotent).
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        DROP CONSTRAINT IF EXISTS competitor_channels_workspace_channel_unique
    `);
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        ADD CONSTRAINT competitor_channels_workspace_channel_unique
        UNIQUE (workspace_id, channel_id)
    `);

    // Listing index — mirrors the pattern from 0037.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_competitor_channels_workspace_created
        ON competitor_channels(workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        DROP CONSTRAINT IF EXISTS competitor_channels_workspace_channel_unique
    `);
    await client.query(`DROP INDEX IF EXISTS idx_competitor_channels_workspace_created`);
    // Don't restore the legacy global UNIQUE — it would fail if any
    // (channel_id) collision exists across workspaces, which is the
    // scenario this migration enables. Operator can re-add manually
    // after deduplicating.
  },
};

export default migration;
