import type { Migration } from './types';

/**
 * Bring `google_auth_tokens` fully into the workspace-scoping model.
 *
 * The table was added to ROOT_TENANT_TABLES in 0011/0013 — meaning the
 * generic `workspace_id UUID NOT NULL` rollout was supposed to cover it.
 * In practice the table is created lazily by `ensureGoogleAuthSchema()`
 * on first OAuth attempt. On any DB where that lazy create ran AFTER
 * 0011/0013, the table exists WITHOUT a workspace_id column at all —
 * those migrations skipped it with `IF EXISTS` because the table wasn't
 * there yet. On any DB where the lazy create ran BEFORE 0011/0013, the
 * column is present and NOT NULL — but the helpers in google-oauth.ts
 * never wrote it, so every INSERT raised a NOT NULL violation and the
 * "Connect Google" flow silently broke.
 *
 * Two structural fixes needed regardless of which path the DB took:
 *
 *   1. Ensure `workspace_id` exists, is backfilled, and is NOT NULL.
 *      Backfill target = the oldest workspace (the bootstrap from 0005)
 *      because the broken INSERT means there are essentially no rows to
 *      migrate, but we belt-and-brace it anyway.
 *
 *   2. Replace the legacy `UNIQUE (email)` constraint with a workspace-
 *      scoped `UNIQUE (workspace_id, email)`. The original constraint
 *      meant two workspaces could not connect the same Google account,
 *      and `ON CONFLICT (email) DO UPDATE` would have silently mutated
 *      another workspace's row had the broken INSERT ever succeeded.
 *      Mirrors the pattern from 0019_channels_workspace_unique.
 *
 * On a fresh install where the table was never lazily created, we skip
 * the entire migration — `ensureGoogleAuthSchema()` (updated in this PR)
 * will declare the new shape from the start.
 */
const migration: Migration = {
  id: '0036_google_auth_tokens_workspace_unique',
  description: 'Backfill workspace_id on google_auth_tokens and replace UNIQUE(email) with UNIQUE(workspace_id, email)',

  async up(client) {
    const { rows: tableRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'google_auth_tokens'
       ) AS exists`,
    );
    if (!tableRows[0]?.exists) return;

    // -- 1. workspace_id column + backfill + NOT NULL ------------------------
    // ADD COLUMN IF NOT EXISTS handles the "lazy create after 0013" case
    // where the column was never added by 0011's generic ALTER pass.
    await client.query(`
      ALTER TABLE google_auth_tokens
        ADD COLUMN IF NOT EXISTS workspace_id UUID
        REFERENCES workspaces(id) ON DELETE CASCADE
    `);

    const { rows: wsRows } = await client.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const bootstrapWorkspaceId = wsRows[0]?.id;
    if (!bootstrapWorkspaceId) {
      // 0005 must have run; if it hasn't, refusing here is louder than
      // silently leaving NULLs that the SET NOT NULL below would catch
      // anyway.
      throw new Error(
        'No workspace exists. Migration 0005 must run before 0036 — refusing to backfill into a phantom workspace.',
      );
    }
    await client.query(
      `UPDATE google_auth_tokens SET workspace_id = $1 WHERE workspace_id IS NULL`,
      [bootstrapWorkspaceId],
    );
    await client.query(
      `ALTER TABLE google_auth_tokens ALTER COLUMN workspace_id SET NOT NULL`,
    );
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_google_auth_tokens_workspace
        ON google_auth_tokens(workspace_id)
    `);

    // -- 2. Constraint swap --------------------------------------------------
    // Default Postgres name for the inline `email TEXT NOT NULL UNIQUE` is
    // `<table>_<column>_key`. DROP IF EXISTS handles the case where it was
    // named otherwise or already absent.
    await client.query(
      `ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_email_key`,
    );
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
      `ALTER TABLE google_auth_tokens DROP CONSTRAINT IF EXISTS google_auth_tokens_workspace_email_unique`,
    );
    // Restoring the legacy global UNIQUE would fail if any (email) collides
    // across workspaces — emit but don't ADD; operator can re-add manually.
  },
};

export default migration;
