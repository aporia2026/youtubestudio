import type { Migration } from './types';

/**
 * Plan: `_plans/2026-05-26-batch-from-scheduled-items.md`.
 *
 * Adds `pipeline_run_video_id` to `schedule_items` so a scheduled item
 * picked into a batch on `/pipeline/new` can be linked back to the
 * `pipeline_run_videos` row it spawned. The Start-a-batch flow uses
 * this column to (a) avoid creating duplicate ideas when the same
 * item is batched twice (future hardening) and (b) let the schedule
 * surface pipeline progress alongside the item's status.
 *
 * ON DELETE SET NULL — deleting a run shouldn't take the schedule
 * item with it; the item just loses its pipeline link.
 *
 * Partial index because the column is null for every item that
 * hasn't been batched (the common case), and the workspace-wide
 * "which items are in the pipeline" query only ever cares about
 * the non-null rows.
 */
const migration: Migration = {
  id: '0092_add_schedule_pipeline_run_video',
  description: 'schedule_items.pipeline_run_video_id link for batch-from-schedule',

  async up(client) {
    await client.query(`
      ALTER TABLE schedule_items
        ADD COLUMN IF NOT EXISTS pipeline_run_video_id UUID
        REFERENCES pipeline_run_videos(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_schedule_items_pipeline_run_video
        ON schedule_items (pipeline_run_video_id)
        WHERE pipeline_run_video_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_schedule_items_pipeline_run_video`);
    await client.query(`ALTER TABLE schedule_items DROP COLUMN IF EXISTS pipeline_run_video_id`);
  },
};

export default migration;
