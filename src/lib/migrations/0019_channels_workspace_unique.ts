import type { Migration } from './types';

/**
 * Replace the legacy global UNIQUE on channels(channel_id) with a workspace-
 * scoped compound UNIQUE on (workspace_id, channel_id).
 *
 * The legacy constraint had two failure modes:
 *
 *   1. Two different workspaces could not add the same external YouTube
 *      channel — INSERTs from workspace B would conflict with workspace A's
 *      row even though they're tenant-isolated.
 *
 *   2. The POST /api/channels handler used ON CONFLICT (channel_id) DO
 *      UPDATE, which would *update across the workspace boundary* when the
 *      conflict was on another workspace's row — leaking workspace A's
 *      account_label, account_email, etc. into workspace B's request.
 *
 * The compound UNIQUE fixes both: NULL channel_ids stay allowed (Postgres
 * UNIQUE treats NULLs as distinct), and every workspace can independently
 * add the same external channel.
 *
 * The legacy constraint name follows Postgres's default of
 * `<table>_<column>_key` (`channels_channel_id_key`). DROP CONSTRAINT IF
 * EXISTS handles the case where it was named differently or already absent.
 */
const migration: Migration = {
  id: '0019_channels_workspace_unique',
  description: 'Replace channels(channel_id) global UNIQUE with (workspace_id, channel_id) compound',

  async up(client) {
    // Drop the legacy global UNIQUE. The default Postgres name is
    // `<table>_<column>_key`; falls through if it's missing or named oddly.
    await client.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_channel_id_key`);

    // Add the workspace-scoped compound. IF NOT EXISTS isn't supported on
    // ADD CONSTRAINT, so we DROP-IF-EXISTS first to make the migration
    // idempotent across re-runs.
    await client.query(`
      ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_workspace_channel_id_unique
    `);
    await client.query(`
      ALTER TABLE channels
        ADD CONSTRAINT channels_workspace_channel_id_unique
        UNIQUE (workspace_id, channel_id)
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_workspace_channel_id_unique
    `);
    // Restoring the legacy UNIQUE would fail if any (channel_id) collides
    // across workspaces — emit but don't ADD; operator can re-add manually.
  },
};

export default migration;
