import type { Migration } from './types';

/**
 * Schema-drift heal: re-add the workspace-scoped UNIQUE constraints that were
 * silently dropped during the live-site interlude described in 0036b's header.
 *
 * Background:
 *   - 0019 added `channels_workspace_channel_id_unique` on
 *     (workspace_id, channel_id).
 *   - 0036 added `google_auth_tokens_workspace_email_unique` on
 *     (workspace_id, email).
 *   - During the live-site interlude, the self-heal ran
 *     `ALTER TABLE ... DROP COLUMN workspace_id CASCADE` on every public
 *     tenant table. CASCADE dropped both UNIQUE constraints with the column.
 *   - 0036b re-added the column and re-enforced NOT NULL, but it did NOT
 *     recreate the UNIQUE constraints. The post-0036 `competitor_channels`
 *     constraint from 0038 survived because 0038 ran AFTER 0036b.
 *
 * Symptom on a drifted DB:
 *   - POST /api/channels fails with
 *     "there is no unique or exclusion constraint matching the
 *     ON CONFLICT specification"
 *     because the route uses ON CONFLICT (workspace_id, channel_id).
 *   - The "Connect Google" upsert has the same shape and would fail the same
 *     way on any account that completed OAuth before the drift.
 *
 * What this migration does:
 *   - Idempotently re-creates both UNIQUE constraints. `DROP IF EXISTS`
 *     handles the case where a healthy DB already has them; the `ADD` is
 *     then safe.
 *   - Skips `google_auth_tokens` if the table was never lazily created (same
 *     pattern as 0036).
 *
 * Pre-condition verified on the affected DB before authoring this migration:
 *   - 0 duplicate (workspace_id, channel_id) groups in `channels`.
 *   - 0 duplicate (workspace_id, email) groups in `google_auth_tokens`.
 *   - On a DB where duplicates DO exist (shouldn't, given the app code never
 *     inserted across the boundary), the ADD CONSTRAINT will fail loudly —
 *     the correct behaviour. An operator must reconcile the duplicates before
 *     the migration can succeed.
 *
 * Why a new id instead of mutating 0019/0036/0036b:
 *   - schema_migrations is append-only by convention (see 0036b's header).
 *     Re-applying an already-applied id would require deleting rows and
 *     bypassing the runner's ordering check.
 */
const migration: Migration = {
  id: '0061_reheal_workspace_unique_constraints',
  description: 'Re-add workspace-scoped UNIQUE constraints on channels and google_auth_tokens dropped by the live-site CASCADE',

  async up(client) {
    // -- channels (workspace_id, channel_id) -------------------------------
    // The `channels` table is created by ensureChannelsSchema() on first
    // request, so it always exists by the time any migration runs. No
    // existence guard needed.
    await client.query(
      `ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_workspace_channel_id_unique`,
    );
    await client.query(`
      ALTER TABLE channels
        ADD CONSTRAINT channels_workspace_channel_id_unique
        UNIQUE (workspace_id, channel_id)
    `);

    // -- google_auth_tokens (workspace_id, email) --------------------------
    // Lazily created on first OAuth attempt. Skip on a DB that never wired
    // up OAuth — ensureGoogleAuthSchema() will declare the right shape from
    // the start when it eventually runs.
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'google_auth_tokens'
       ) AS exists`,
    );
    if (!rows[0]?.exists) return;

    await client.query(
      `ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_workspace_email_unique`,
    );
    await client.query(`
      ALTER TABLE google_auth_tokens
        ADD CONSTRAINT google_auth_tokens_workspace_email_unique
        UNIQUE (workspace_id, email)
    `);
  },

  async down(client) {
    await client.query(
      `ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_workspace_channel_id_unique`,
    );
    await client.query(
      `ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_workspace_email_unique`,
    );
  },
};

export default migration;
