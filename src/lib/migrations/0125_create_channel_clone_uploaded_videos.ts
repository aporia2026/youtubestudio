import type { Migration } from './types';

/**
 * channel_clone_uploaded_videos — workspace-scoped reusable library of
 * every reference video the operator has ever uploaded into a channel-
 * clone run. Decoupled from `channel_clone_jobs.state_jsonb` so the
 * library survives a job's deletion.
 *
 * Why this exists (2026-06-08):
 *   The "Pick from previous uploads" picker on the upload form lets
 *   the operator reuse videos + transcripts across runs. Until now
 *   the picker reconstructed staging keys from each job's
 *   `state_jsonb.intake.sampleVideos`. That coupling meant deleting a
 *   job ALSO destroyed its videos in the picker (and the DELETE
 *   handler additionally nuked the R2 staging prefix). Operators who
 *   tidied old runs lost the ability to reuse those videos. The user
 *   pushed back hard — "It needs to save the uploaded videos and
 *   transcripts regardless! These are all videos that are in our
 *   storage!" — and they're right.
 *
 *   This table is the durable record. The runner inserts a row per
 *   video at end-of-intake (after the bytes land in
 *   channel-clone-uploads-staging/<wsId>/<jobId>/<NNN>.<ext>). The
 *   picker queries this table directly, no job-row walking needed.
 *   Deleting a job no longer touches R2 or this table.
 *
 * Schema choices:
 *   - PK `id` synthetic so the row outlives any reshuffling of jobs.
 *   - `r2_key TEXT NOT NULL` is the staging-prefix key. Indexed UNIQUE
 *     per workspace so a re-ingest of the same bytes (which would
 *     produce the same key under the same prefix) upserts cleanly
 *     instead of creating a duplicate row.
 *   - `source_job_id UUID` references the originating job for display
 *     purposes only — NO FK constraint so the row stays valid when
 *     the job is deleted.
 *   - `source_job_name TEXT` is the snapshot of the job's source
 *     channel name / source label at upload time. The originating
 *     job may be gone by the time the picker renders this row, so
 *     we keep the label here.
 *
 * Indexes:
 *   - workspace_created_idx for the most-recent-first picker query.
 *   - r2_key UNIQUE per workspace for the upsert-on-reingest path.
 */
const migration: Migration = {
  id: '0125_create_channel_clone_uploaded_videos',
  description: 'Create channel_clone_uploaded_videos — workspace-scoped library of reusable reference videos',

  async up(client) {
    await client.query(`
      CREATE TABLE channel_clone_uploaded_videos (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id            UUID NOT NULL,
        r2_key                  TEXT NOT NULL,
        title                   TEXT NOT NULL,
        transcript              TEXT NOT NULL DEFAULT '',
        transcript_word_count   INTEGER NOT NULL DEFAULT 0,
        duration_sec            INTEGER NOT NULL DEFAULT 0,
        source_job_id           UUID,
        source_job_name         TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX channel_clone_uploaded_videos_workspace_r2key_uniq
        ON channel_clone_uploaded_videos (workspace_id, r2_key)
    `);
    await client.query(`
      CREATE INDEX channel_clone_uploaded_videos_workspace_created_idx
        ON channel_clone_uploaded_videos (workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS channel_clone_uploaded_videos_workspace_created_idx`);
    await client.query(`DROP INDEX IF EXISTS channel_clone_uploaded_videos_workspace_r2key_uniq`);
    await client.query(`DROP TABLE IF EXISTS channel_clone_uploaded_videos`);
  },
};

export default migration;
