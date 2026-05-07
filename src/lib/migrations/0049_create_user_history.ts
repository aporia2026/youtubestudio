import type { Migration } from './types';

/**
 * Server-synced history for the seven generator panels (script, ideas,
 * voiceover, seo, thumbnail, qa, production_doc) that previously stored
 * their entries in the browser's localStorage.
 *
 * Per-user, per-workspace scoping (mirrors `asked_by_collaborator_id` in
 * `ask_studio_questions`). Each teammate sees their own history;
 * collaborators on the same workspace do NOT see each other's entries.
 *
 * Polymorphic: a single `kind` discriminator + JSONB payload, because
 * the seven existing TypeScript shapes are already JSON-blob-shaped
 * (most have a free-form `result?: unknown` or `payload?: unknown`
 * field) and a single table means one API surface, one read path, one
 * cap-trimming strategy.
 *
 * `client_id` is the legacy localStorage-side `id` (e.g.
 * `${Date.now()}-${random}`). The one-shot migration in the client
 * library uploads each existing localStorage entry with its old id in
 * this column. The partial unique index makes the upload idempotent —
 * if the same browser somehow runs the migration twice, the second
 * pass is a no-op instead of a duplicate insert.
 *
 * Hot path is `(workspace_id, collaborator_id, kind, created_at DESC)`
 * for the panel listing — a single composite index covers it.
 */
const migration: Migration = {
  id: '0049_create_user_history',
  description: 'Per-user history for the seven generator panels — replaces browser localStorage so history syncs across devices',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_history (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        collaborator_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        payload         JSONB NOT NULL,
        client_id       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /**
     * Single composite index covering the only read pattern: list a
     * given user's recent entries of one kind in this workspace,
     * newest first.
     *
     * The `id DESC` tiebreaker matters for `trimToCap` — without a
     * total ordering, two rows sharing a millisecond `created_at`
     * (possible during the localStorage migration's tight loop) have
     * undefined position relative to each other, and the cap-trim
     * could drop a just-inserted row instead of an older one. Adding
     * `id DESC` to both the index and the trim query's ORDER BY gives
     * the planner a stable, index-only scan.
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_history_lookup
        ON user_history(workspace_id, collaborator_id, kind, created_at DESC, id DESC)
    `);

    /**
     * Idempotency guard for the one-shot localStorage migration. A
     * partial unique index avoids spending the unique-constraint
     * overhead on the common case (server-native inserts pass NULL
     * for client_id). When the migration runs, every uploaded row
     * carries its legacy id — re-running it on the same browser
     * collides on this index instead of duplicating.
     */
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_history_client_dedupe
        ON user_history(workspace_id, collaborator_id, kind, client_id)
        WHERE client_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS user_history`);
  },
};

export default migration;
