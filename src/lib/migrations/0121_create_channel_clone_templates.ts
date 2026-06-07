import type { Migration } from './types';

/**
 * Plan: _plans/2026-06-07-channel-clone-preset-templates.md.
 *
 * channel_clone_templates lets an operator save a working channel-clone
 * configuration — source channel URL, frame interval, transcripts,
 * AND the uploaded reference video files themselves — and re-spin
 * new runs from it later without re-uploading.
 *
 * Schema choices:
 *   - JSONB `config_jsonb` holds the snapshot of intake inputs in a
 *     shape that mirrors the intake-upload route's body, with the
 *     per-video r2Key fields pointing at the template's own R2 prefix
 *     (NOT the original job's prefix — templates own their copies so
 *     they survive the source job being deleted).
 *   - `r2_keys text[]` is the manifest of every R2 object the template
 *     owns. The DELETE flow walks this array to reclaim storage.
 *   - `bytes` is the total payload size — surfaced to the operator
 *     for storage transparency. Sum of all videos + any future
 *     artefacts (e.g. cloned voice samples) we copy in.
 *   - Soft-delete via `deleted_at`: the DELETE endpoint sets this
 *     and queues the R2 delete in the background; a sweep cron
 *     finishes the job 24h later. Two-phase guards against partial
 *     R2 failures leaving SQL row + R2 objects out of sync.
 *
 * Indexes:
 *   - workspace_name unique partial (deleted_at IS NULL) so the
 *     save-replace flow is a cheap upsert and the operator can
 *     re-use a name after delete.
 *   - workspace + created_at DESC partial for the dropdown list.
 *
 * Down: drop indexes + table. No FK; channel_clone_jobs do not
 * reference templates (the load flow copies template R2 keys into
 * a brand-new job's intake state instead).
 */
const migration: Migration = {
  id: '0121_create_channel_clone_templates',
  description: 'Create channel_clone_templates — saved snapshots of channel-clone configurations (incl. uploaded reference videos)',

  async up(client) {
    await client.query(`
      CREATE TABLE channel_clone_templates (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL,
        created_by    UUID NOT NULL,
        name          TEXT NOT NULL,
        config_jsonb  JSONB NOT NULL,
        r2_keys       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        bytes         BIGINT NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at    TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX channel_clone_templates_workspace_name_uniq
        ON channel_clone_templates (workspace_id, lower(name))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX channel_clone_templates_workspace_created_idx
        ON channel_clone_templates (workspace_id, created_at DESC)
        WHERE deleted_at IS NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS channel_clone_templates_workspace_created_idx`);
    await client.query(`DROP INDEX IF EXISTS channel_clone_templates_workspace_name_uniq`);
    await client.query(`DROP TABLE IF EXISTS channel_clone_templates`);
  },
};

export default migration;
