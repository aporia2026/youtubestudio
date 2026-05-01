import type { Migration } from './types';

/**
 * Create the `workspaces` table. A workspace is the unit of multi-tenancy:
 * every project, channel, schedule item, etc. belongs to exactly one
 * workspace, and every API query is scoped by `workspace_id`.
 *
 * `owner_user_id` references `collaborators(id)` — the existing user table.
 * The FK is added in this migration; collaborators already exists from the
 * legacy `ensureTeamSchema()` path.
 *
 * If the production DB has never run `ensureTeamSchema`, `collaborators`
 * won't exist yet and the FK creation will fail. We pre-empt that by
 * creating the minimum collaborators shell here too — `IF NOT EXISTS`
 * makes it a no-op on databases where the table is already populated.
 */
const migration: Migration = {
  id: '0002_create_workspaces',
  description: 'Create the workspaces tenancy table',

  async up(client) {
    // Belt-and-braces: ensure collaborators exists so the FK below resolves.
    // Real columns/constraints are added by the legacy ensureTeamSchema path
    // and by the next migration (0003). This is the bare minimum the FK needs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS collaborators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'reviewer',
        color TEXT NOT NULL DEFAULT '#7c3aed',
        specialties JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        owner_user_id UUID NOT NULL REFERENCES collaborators(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS workspaces`);
  },
};

export default migration;
