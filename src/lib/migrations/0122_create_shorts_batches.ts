import type { Migration } from './types';

/**
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * shorts_batches groups N shorts that were planned + generated +
 * (optionally) uploaded together. One row per batch — the actual
 * shorts live in the existing `shorts` table and link back via
 * `shorts.batch_id` (added in migration 0123).
 *
 * Schema choices:
 *   - `channel_id` is the YouTube upload target. Nullable so a batch
 *     can exist before a channel is picked (e.g. drafted while no
 *     channel is OAuth-connected). ON DELETE SET NULL — losing the
 *     channel link shouldn't wipe historical batch metadata.
 *   - `defaults` JSONB carries the batch-level form state (voice,
 *     language, category, description template, tag pool, default
 *     privacy, schedule cadence, timezone, made-for-kids). Kept as
 *     opaque JSON so the UI can evolve without coordinated
 *     migrations. The TS shape lives in shorts-batches-types.ts.
 *   - `totals` JSONB carries denormalised counters (planned,
 *     generated, failed, uploaded, scheduled) so the dashboard can
 *     render a batch row without a JOIN + GROUP BY. The orchestrator
 *     keeps this in sync; the per-short rows in `shorts` are the
 *     authoritative source if the two ever drift.
 *   - `status` is the batch-level state machine ('setup' → 'generating'
 *     → 'review' → 'uploading' → 'done' / 'failed'). Held as TEXT
 *     with a CHECK constraint so future states can be added by a
 *     follow-up migration without breaking the constraint.
 *
 * Indexes:
 *   - workspace + created_at DESC for the batch list page.
 *   - workspace + status partial for the "active batches" surface
 *     (cheap because most batches end in 'done' / 'failed' over time).
 *
 * Down: drop indexes + table. Safe because the dependent FK on
 * shorts.batch_id is added in 0123 with ON DELETE SET NULL — the
 * shorts themselves survive a batch delete.
 */
const migration: Migration = {
  id: '0122_create_shorts_batches',
  description: 'Create shorts_batches — first-class cohort tracking for bulk shorts generation + upload',

  async up(client) {
    await client.query(`
      CREATE TABLE shorts_batches (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
        created_by    UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        name          TEXT,
        status        TEXT NOT NULL DEFAULT 'setup',
        defaults      JSONB NOT NULL DEFAULT '{}'::jsonb,
        totals        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Named CHECK so down() can drop it; idempotent guard so a partial
    // failure on rerun doesn't blow up on the second pass.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shorts_batches_status_check'
        ) THEN
          ALTER TABLE shorts_batches
            ADD CONSTRAINT shorts_batches_status_check
            CHECK (status IN ('setup', 'generating', 'review', 'uploading', 'done', 'failed'));
        END IF;
      END$$;
    `);

    await client.query(`
      CREATE INDEX shorts_batches_workspace_created_idx
        ON shorts_batches (workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX shorts_batches_workspace_status_idx
        ON shorts_batches (workspace_id, status)
        WHERE status IN ('setup', 'generating', 'review', 'uploading')
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS shorts_batches_workspace_status_idx`);
    await client.query(`DROP INDEX IF EXISTS shorts_batches_workspace_created_idx`);
    await client.query(`ALTER TABLE shorts_batches DROP CONSTRAINT IF EXISTS shorts_batches_status_check`);
    await client.query(`DROP TABLE IF EXISTS shorts_batches`);
  },
};

export default migration;
