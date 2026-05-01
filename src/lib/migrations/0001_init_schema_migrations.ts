import type { Migration } from './types';

/**
 * Sentinel migration. The runner already creates `schema_migrations` before
 * processing any migration (chicken-and-egg bootstrap), so this migration
 * mostly records the fact that the Phase 1 migration system is initialised.
 *
 * The CREATE TABLE IF NOT EXISTS keeps it idempotent and a useful self-test:
 * if the runner-bootstrap path is ever broken, this catches it.
 */
const migration: Migration = {
  id: '0001_init_schema_migrations',
  description: 'Bootstrap schema_migrations tracking table (sentinel)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  },

  // No down: removing schema_migrations would invalidate the entire system.
};

export default migration;
