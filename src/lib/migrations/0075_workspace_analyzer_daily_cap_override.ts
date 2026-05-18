import type { Migration } from './types';

/**
 * Per-workspace override for the deep-analyzer's per-user daily cap
 * (Phase 4 of `_plans/2026-05-18-youtube-deep-analyzer.md`).
 *
 * The analyzer POST route (src/app/api/analyze/youtube-video/route.ts)
 * defaults to a soft cap of 20 analyses / user / day. NULL on this
 * column means "use the default." Setting a positive integer raises
 * (or lowers) the cap for every user in that workspace.
 *
 * Why an override column on `workspaces` rather than a generic
 * key/value setting table:
 *   - Single-purpose setting, single column.
 *   - Read path is a one-line UPDATE / SELECT on a row we already
 *     load most requests anyway. No JOIN to a settings table.
 *   - Admin endpoint validates the integer in code before write, so
 *     we don't need the generic-settings dance.
 *
 * Set to 0 to effectively disable analyses for this workspace (the
 * route's `>=` check returns 429 immediately when the count meets
 * the cap). Set to a high number (e.g. 200) to lift the cap for a
 * power-user workspace.
 */
const migration: Migration = {
  id: '0075_workspace_analyzer_daily_cap_override',
  description: 'Add analyses_per_user_per_day_override column to workspaces (NULL = default cap of 20)',

  async up(client) {
    await client.query(`
      ALTER TABLE workspaces
        ADD COLUMN IF NOT EXISTS analyses_per_user_per_day_override INTEGER
    `);
    // Range check: 0 disables, positive integers override, no
    // negatives. NULL passes through (no constraint violation when
    // the column is omitted on existing rows or future INSERTs).
    await client.query(`
      ALTER TABLE workspaces
        DROP CONSTRAINT IF EXISTS workspaces_analyses_cap_nonneg
    `);
    await client.query(`
      ALTER TABLE workspaces
        ADD CONSTRAINT workspaces_analyses_cap_nonneg
          CHECK (analyses_per_user_per_day_override IS NULL OR analyses_per_user_per_day_override >= 0)
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_analyses_cap_nonneg`);
    await client.query(`ALTER TABLE workspaces DROP COLUMN IF EXISTS analyses_per_user_per_day_override`);
  },
};

export default migration;
