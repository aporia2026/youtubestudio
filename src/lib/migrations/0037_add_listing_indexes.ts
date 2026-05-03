import type { Migration } from './types';

/**
 * Composite indexes for the most common list-endpoint query shapes.
 *
 * Audit finding m7: list functions filter by (workspace_id, X) and
 * sort by created_at/started_at — but the existing per-table indexes
 * cover only `workspace_id` alone. PG can use them but still has to
 * sort the matched set in memory. Composite indexes that include the
 * sort column eliminate the sort step entirely.
 *
 * All four indexes use `IF NOT EXISTS` so re-running is a no-op.
 * `CONCURRENTLY` is intentionally omitted — these tables are small
 * enough that the brief lock during CREATE INDEX is acceptable, and
 * `CONCURRENTLY` can't run inside the migration runner's BEGIN/COMMIT.
 */
const migration: Migration = {
  id: '0037_add_listing_indexes',
  description: 'Composite indexes for ab_tests / critic_panels / published_videos / dubbed_voiceovers list paths',

  async up(client) {
    // ab_tests: listAbTests filters by (workspace_id, schedule_item_id)
    // OR (workspace_id, youtube_video_id) and sorts by created_at DESC.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_workspace_schedule_created
        ON ab_tests(workspace_id, schedule_item_id, created_at DESC)
        WHERE schedule_item_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_workspace_youtube_created
        ON ab_tests(workspace_id, youtube_video_id, created_at DESC)
    `);

    // critic_panels: listCriticPanels filters by (workspace_id, project_id)
    // OR (workspace_id, source_script_id) and sorts by started_at DESC.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panels_workspace_project_started
        ON critic_panels(workspace_id, project_id, started_at DESC)
        WHERE project_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panels_workspace_script_started
        ON critic_panels(workspace_id, source_script_id, started_at DESC)
        WHERE source_script_id IS NOT NULL
    `);

    // published_videos: listPublishedVideos filters by (workspace_id,
    // channel_db_id) and (workspace_id, schedule_item_id) and
    // (workspace_id, project_id), sorted by created_at DESC. Plus the
    // workspace + status partial index from 0035 already covers the
    // status-pending path.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_published_videos_workspace_schedule_created
        ON published_videos(workspace_id, schedule_item_id, created_at DESC)
        WHERE schedule_item_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_published_videos_workspace_project_created
        ON published_videos(workspace_id, project_id, created_at DESC)
        WHERE project_id IS NOT NULL
    `);

    // dubbed_voiceovers: listDubsForScript filters by (script_id,
    // workspace_id) sorted by target_language. Existing PK
    // (script_id, target_language) already covers — no new index.
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_ab_tests_workspace_schedule_created`);
    await client.query(`DROP INDEX IF EXISTS idx_ab_tests_workspace_youtube_created`);
    await client.query(`DROP INDEX IF EXISTS idx_critic_panels_workspace_project_started`);
    await client.query(`DROP INDEX IF EXISTS idx_critic_panels_workspace_script_started`);
    await client.query(`DROP INDEX IF EXISTS idx_published_videos_workspace_schedule_created`);
    await client.query(`DROP INDEX IF EXISTS idx_published_videos_workspace_project_created`);
  },
};

export default migration;
