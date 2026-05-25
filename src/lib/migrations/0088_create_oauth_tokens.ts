import type { Migration } from './types';

/**
 * Create the `oauth_tokens` table if it doesn't already exist.
 *
 * Background: `oauth_tokens` was originally created inside `initDatabase()`
 * in `src/lib/db.ts`. That function is only invoked by hand — it never runs
 * automatically on deploy. Workspaces whose database was bootstrapped via
 * the migration runner (rather than via `initDatabase`) ended up without
 * the table, and `getValidAccessToken` started 500-ing the moment any
 * route touched OAuth state ("relation oauth_tokens does not exist").
 *
 * The workspace-scoping passes in `_workspace_scoped_tables.ts` use
 * `ALTER TABLE IF EXISTS` so they silently no-op'd against the missing
 * table, which is why this hole stayed hidden for so long.
 *
 * Schema below is the post-0013 shape (includes workspace_id) so a fresh
 * create on a workspace-aware database lands the final form in one shot.
 * For databases where the table partially exists (e.g. an early dev
 * environment where `initDatabase()` ran but later migrations did not),
 * the trailing ALTER TABLE IF NOT EXISTS passes patch in any missing
 * columns. All operations are idempotent.
 */
const migration: Migration = {
  id: '0088_create_oauth_tokens',
  description: 'Backfill the oauth_tokens table for workspaces bootstrapped via the migration runner',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'google',
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT,
        token_expiry TIMESTAMPTZ NOT NULL,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        google_email TEXT,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(channel_id, provider)
      )
    `);
    // Patch passes for databases where the table existed pre-workspace
    // tenancy: ensure every required column is present so any caller
    // that assumes the post-0013 shape works.
    await client.query(`ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS google_email TEXT`);
    await client.query(`ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE`);
    // Index for the most common access pattern (channel + provider lookup).
    // The UNIQUE constraint already covers this but an explicit index keeps
    // EXPLAIN output legible across schema variants.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_channel_provider ON oauth_tokens(channel_id, provider)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_workspace ON oauth_tokens(workspace_id) WHERE workspace_id IS NOT NULL`);
  },

  async down(client) {
    // Down only drops the table when it has no rows — refuses to drop a
    // populated tokens table even on rollback, because losing refresh
    // tokens silently is a much worse failure than the rollback itself.
    const { rows } = await client.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM oauth_tokens`);
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count > 0) {
      throw new Error(`Refusing to drop oauth_tokens: ${count} row(s) present. Migrate or delete them first.`);
    }
    await client.query(`DROP TABLE IF EXISTS oauth_tokens`);
  },
};

export default migration;
