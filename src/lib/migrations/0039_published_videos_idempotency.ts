import type { Migration } from './types';

/**
 * Idempotency-key support for publishing.
 *
 * Audit C7: a network blip between the client clicking Publish and the
 * server's response would have the modal retry the POST — creating a
 * duplicate published_videos row + a duplicate YouTube upload. The
 * standard fix is an Idempotency-Key header: the client sends a stable
 * UUID per intent, the server stores it, and a retry with the same
 * key returns the SAME row instead of creating a second one.
 *
 * Storage shape: nullable text column (legacy clients that don't send
 * the header still work, just lose retry safety) with a partial UNIQUE
 * index on (workspace_id, idempotency_key) WHERE idempotency_key IS
 * NOT NULL. Partial so NULLs don't all collide.
 */
const migration: Migration = {
  id: '0039_published_videos_idempotency',
  description: 'Add idempotency_key column to published_videos with workspace-scoped UNIQUE',

  async up(client) {
    await client.query(`
      ALTER TABLE IF EXISTS published_videos
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT
    `);
    // Partial UNIQUE — only enforces uniqueness on rows where the
    // client actually sent a key. Two NULLs don't conflict in any
    // Postgres unique constraint, but a partial index makes the
    // intent explicit and saves index space.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_published_videos_workspace_idempotency
        ON published_videos(workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS uq_published_videos_workspace_idempotency`);
    await client.query(`ALTER TABLE IF EXISTS published_videos DROP COLUMN IF EXISTS idempotency_key`);
  },
};

export default migration;
