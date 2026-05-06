import type { Migration, MigrationClient } from './types';

/**
 * Companion to 0036b — re-heals workspace_id on tables created AFTER the
 * original 0011/0012/0013 rollout.
 *
 * Why two heal migrations: 0036b drives off `_workspace_scoped_tables.ts`,
 * which is the single source of truth for the *original* tenant tables
 * rolled out in 0011. Tables added by later migrations (0017 messages,
 * 0018 video_analytics, 0020-0035 feature tables, etc.) carry their own
 * `workspace_id NOT NULL` directly in CREATE TABLE — they were never in
 * `_workspace_scoped_tables.ts` because they didn't need a backfill pass.
 *
 * Today's live-site self-heal didn't know that distinction — its
 * information_schema-driven DROP COLUMN walked over every table with a
 * `workspace_id` column, including these later additions. So we have to
 * re-heal them too.
 *
 * Hardcoded list because:
 *   - The list is fixed (we can derive it from migrations 0017-0035 by
 *     reading their CREATE TABLE statements).
 *   - An information_schema-driven approach would have to *guess* which
 *     tables ought to have workspace_id, which is impossible without the
 *     migration history (rate_limits doesn't have it, admin_audit_log
 *     uses target_workspace_id instead, etc.).
 *
 * Idempotent: every step uses IF NOT EXISTS or works on rows where
 * workspace_id IS NULL — no-ops once the column exists and is populated.
 */

/** Tables that gained `workspace_id NOT NULL` after the 0011 rollout. */
const POST_0011_TENANT_TABLES = [
  'messages',                  // 0017
  'video_analytics',           // 0018
  'dubbed_voiceovers',         // 0020
  'shorts',                    // 0021
  'broll_clips',               // 0023
  'ab_tests',                  // 0024
  'ab_test_snapshots',         // 0024
  'critic_panels',             // 0025
  'critic_panel_events',       // 0025
  'retention_predictions',     // 0026
  'dip_analyses',              // 0027
  'cannibalization_alerts',    // 0028
  'ask_studio_questions',      // 0029
  'webhook_subscriptions',     // 0030
  'webhook_deliveries',        // 0030
  'youtube_comments',          // 0031
  'comment_sync_runs',         // 0031
  'workflow_rules',            // 0032
  'workflow_action_runs',      // 0032
  'ai_spend_log',              // 0033
  'workspace_model_defaults',  // 0034
  'published_videos',          // 0035
] as const;

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
for (const t of POST_0011_TENANT_TABLES) {
  if (!SAFE_IDENT.test(t)) throw new Error(`Unsafe table identifier: ${t}`);
}

const migration: Migration = {
  id: '0036c_reheal_post_0011_tables',
  description: 'Re-add workspace_id on tables created by 0017-0035 that the live-site interlude dropped',

  async up(client) {
    // Resolve the bootstrap workspace once. All existing rows belong to it
    // — this is a single-user single-workspace deployment.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const bootstrapWorkspaceId = rows[0]?.id;
    if (!bootstrapWorkspaceId) {
      throw new Error('No workspace exists; cannot heal post-0011 tables.');
    }

    const exists = await getExistingTables(client);

    for (const table of POST_0011_TENANT_TABLES) {
      // Skip tables that don't physically exist yet (a fresh DB hasn't
      // necessarily run every CREATE TABLE migration). The runner enforces
      // ordering, so by the time this migration runs, all CREATE TABLE
      // migrations 0017-0035 have run too — so this is mostly defensive.
      if (!exists.has(table)) continue;

      // 1. Ensure the column exists.
      await client.query(
        `ALTER TABLE ${table}
           ADD COLUMN IF NOT EXISTS workspace_id UUID
           REFERENCES workspaces(id) ON DELETE CASCADE`,
      );

      // 2. Backfill NULLs to the bootstrap workspace.
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );

      // 3. Re-enforce NOT NULL (matches the CREATE TABLE intent).
      await client.query(
        `ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL`,
      );

      // 4. Listing index — same naming convention as 0013.
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id)`,
      );
    }
  },
};

async function getExistingTables(client: MigrationClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false))`,
  );
  return new Set(rows.map((r) => r.table_name));
}

export default migration;
