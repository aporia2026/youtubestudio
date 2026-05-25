import type { Migration, MigrationClient } from './types';

/**
 * Replace the legacy global UNIQUE on niches(name) with a workspace-scoped
 * compound UNIQUE on (workspace_id, name).
 *
 * The legacy constraint was inlined as `name TEXT NOT NULL UNIQUE` in the
 * `initDatabase()` lazy create (see src/lib/db.ts). After 0011/0012/0013
 * folded `niches` into the workspace-scoping model, the global UNIQUE became
 * a tenant-bleeding hazard: two workspaces could never both have a niche
 * called "General Tech", and a POST that hit the legacy ON CONFLICT (name)
 * would silently mutate another workspace's row.
 *
 * Mirrors the patterns from:
 *   - 0019_channels_workspace_unique         (channels.channel_id)
 *   - 0036_google_auth_tokens_workspace_unique (google_auth_tokens.email)
 *   - 0038_competitor_channels_workspace_unique
 *
 * Skips entirely if the `niches` table doesn't physically exist — fresh
 * installs hit `initDatabase()` lazily and the updated CREATE TABLE there
 * declares the new shape from the start.
 */
const migration: Migration = {
  id: '0087_niches_workspace_name_unique',
  description: 'Replace niches(name) global UNIQUE with (workspace_id, name) compound',

  async up(client) {
    const exists = await tableExists(client, 'niches');
    if (!exists) return;

    // Drop the legacy global UNIQUE. The default Postgres name for an inline
    // `name TEXT NOT NULL UNIQUE` is `<table>_<column>_key`. DROP IF EXISTS
    // falls through if it's missing or named otherwise.
    await client.query(`ALTER TABLE niches DROP CONSTRAINT IF EXISTS niches_name_key`);

    // ADD CONSTRAINT has no IF NOT EXISTS form, so DROP-then-ADD keeps the
    // migration idempotent across re-runs.
    await client.query(
      `ALTER TABLE niches DROP CONSTRAINT IF EXISTS niches_workspace_name_unique`,
    );
    await client.query(`
      ALTER TABLE niches
        ADD CONSTRAINT niches_workspace_name_unique
        UNIQUE (workspace_id, name)
    `);
  },

  async down(client) {
    await client.query(
      `ALTER TABLE niches DROP CONSTRAINT IF EXISTS niches_workspace_name_unique`,
    );
    // Restoring the legacy global UNIQUE would fail if any (name) collides
    // across workspaces — emit but don't ADD; operator can re-add manually.
  },
};

async function tableExists(client: MigrationClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = $1
     ) AS exists`,
    [table],
  );
  return Boolean(rows[0]?.exists);
}

export default migration;
