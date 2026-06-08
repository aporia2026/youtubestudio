import type { Migration } from './types';

/**
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Adds YouTube upload + batch-membership state to the existing
 * `shorts` table. Each column is independently optional so existing
 * rows (which predate this feature) remain valid without backfill.
 *
 * Columns:
 *   - `batch_id` — soft FK to shorts_batches (added in 0122). NULL
 *     means the short was created outside any batch (the legacy
 *     single-short flow still works unchanged). ON DELETE SET NULL
 *     so deleting a batch doesn't wipe its shorts — the batch is a
 *     planning/tracking concept; the short itself is the asset.
 *   - `youtube_video_id` — YouTube's id once the video is uploaded.
 *     Reads are scoped to the short's workspace before this is
 *     ever rendered, so we don't add a unique constraint (different
 *     workspaces could in theory re-upload the same id after a
 *     deletion + re-upload; the constraint would break that edge).
 *   - `youtube_status` — pending|uploading|uploaded|scheduled|
 *     published|failed. Distinct from the batch-level status so
 *     individual shorts can be retried/edited without affecting the
 *     batch row's status.
 *   - `youtube_publish_at` — scheduled publish time in UTC. NULL
 *     means "publish immediately at upload". When non-NULL, the
 *     uploader forces privacyStatus=private at insert + sets
 *     publishAt on the snippet.status block.
 *   - `youtube_metadata` JSONB — full editable snippet (title,
 *     description, tags[], categoryId, defaultLanguage,
 *     playlistIds[], privacy, madeForKids). Stored as JSONB so the
 *     review UI can edit any subset and PATCH back a partial blob.
 *     Defaults to '{}' for legacy rows; the uploader merges with the
 *     batch defaults at submission time.
 *   - `youtube_uploaded_at` — when the videos.insert call returned
 *     success. Separate from scheduled-publish time.
 *   - `youtube_upload_error` — most-recent upload error message
 *     (truncated server-side before persist; the namespaced log
 *     line is the audit trail). Cleared on successful retry.
 *
 * Indexes:
 *   - batch_id partial — drives the review-queue + batch-detail
 *     reads. Partial so legacy rows (NULL batch_id) don't bloat the
 *     index.
 *   - youtube_status partial — for the "needs upload" + "scheduled"
 *     dashboards.
 *
 * Down: drops every column added here. The batch_id FK is dropped
 * implicitly when the column is dropped.
 */
const migration: Migration = {
  id: '0123_add_youtube_columns_to_shorts',
  description: 'Add YouTube upload + batch membership state to shorts',

  async up(client) {
    await client.query(`
      ALTER TABLE shorts
        ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES shorts_batches(id) ON DELETE SET NULL
    `);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_video_id TEXT`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_status TEXT`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_publish_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_uploaded_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS youtube_upload_error TEXT`);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shorts_youtube_status_check'
        ) THEN
          ALTER TABLE shorts
            ADD CONSTRAINT shorts_youtube_status_check
            CHECK (youtube_status IS NULL OR youtube_status IN (
              'pending', 'uploading', 'uploaded', 'scheduled', 'published', 'failed'
            ));
        END IF;
      END$$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS shorts_batch_idx
        ON shorts (batch_id, created_at DESC)
        WHERE batch_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS shorts_youtube_status_idx
        ON shorts (workspace_id, youtube_status)
        WHERE youtube_status IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS shorts_youtube_status_idx`);
    await client.query(`DROP INDEX IF EXISTS shorts_batch_idx`);
    await client.query(`ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_youtube_status_check`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_upload_error`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_uploaded_at`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_metadata`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_publish_at`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_status`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS youtube_video_id`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS batch_id`);
  },
};

export default migration;
