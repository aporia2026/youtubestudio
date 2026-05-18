import type { Migration } from './types';

/**
 * Optimistic-locking column on `user_history` — Phase 1 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Two surfaces now write to the same production-doc row:
 *
 *   - `/production-doc`   (the historical editor)
 *   - `/editor/[projectId]` (the new shot-graph editor)
 *
 * Without a version column, the second tab to save silently clobbers
 * the first. With it, updates run
 *
 *   UPDATE user_history
 *      SET payload = $1, version = version + 1
 *    WHERE id = $2 AND version = $3
 *
 * and rows-affected = 0 signals a conflict. The client then reloads
 * and surfaces a "newer version exists" toast.
 *
 * DEFAULT 1 backfills every existing row in a single statement; no
 * separate backfill migration needed. New writes from either surface
 * read `version` before mutating, send it back in the update, and
 * trust the database to arbitrate.
 *
 * Single-owner-edits for v1 (operator confirmed 2026-05-18) — no
 * workspace-scope migration; `collaborator_id` remains the row owner.
 * Teammates view, owner edits.
 */
const migration: Migration = {
  id: '0079_user_history_version_column',
  description: 'Add `version` column to user_history for optimistic-locking between /production-doc and /editor',

  async up(client) {
    await client.query(`
      ALTER TABLE user_history
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE user_history
        DROP COLUMN IF EXISTS version
    `);
  },
};

export default migration;
