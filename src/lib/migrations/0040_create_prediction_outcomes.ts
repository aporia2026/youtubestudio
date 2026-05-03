import type { Migration } from './types';

/**
 * Phase 8.5 — close the loop on Phase 4.2's retention predictor.
 *
 * For every (retention_predictions row, video_analytics row) pair where
 * the video has been live ≥14 days, we capture one outcome row that
 * snapshots:
 *
 *   - the predicted curve at prediction time
 *   - the actual retention curve from the published video
 *   - delta_metrics: per-segment drift, MAE, biggest absolute miss,
 *     miss-direction trend (computed once at capture so the dashboard
 *     doesn't have to recompute on every page load)
 *
 * The point: feed those snapshots back into the predictor as few-shot
 * examples instead of raw analytics rows. Raw rows give the model
 * (script, real curve); outcome rows give it (script, predicted, real,
 * how the prediction was wrong). The latter is strictly more signal —
 * the model learns the channel's *delta pattern*, not just its raw
 * curve shape.
 *
 * `youtube_video_id` is denormalised (text, no FK) so the link
 * survives even if the video_analytics row gets re-synced and changes
 * its surrogate identity. video_analytics.PRIMARY KEY is
 * (workspace_id, youtube_video_id), which is itself a natural key, so
 * this is robust.
 *
 * `UNIQUE (workspace_id, retention_prediction_id)` guarantees we capture
 * each prediction exactly once — the cron is idempotent (cheap to
 * re-run) without needing app-level de-dup logic.
 *
 * `ON DELETE CASCADE` on both FKs: if the user deletes the workspace
 * or the prediction, the outcome row is meaningless and should go too.
 */
const migration: Migration = {
  id: '0040_create_prediction_outcomes',
  description: 'Phase 8.5 — capture predicted-vs-actual retention curves so the predictor learns from outcomes',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS prediction_outcomes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        retention_prediction_id UUID NOT NULL REFERENCES retention_predictions(id) ON DELETE CASCADE,

        -- Denormalised link to video_analytics (workspace_id, youtube_video_id).
        -- Not a hard FK because video_analytics rows can be re-synced and we
        -- want this link to survive that.
        youtube_video_id TEXT NOT NULL,

        predicted_curve JSONB NOT NULL,
        actual_curve JSONB NOT NULL,

        -- { mae_pct, biggest_miss_at_pct, biggest_miss_direction,
        --   per_segment_deltas: [{ position, predicted, actual, delta }, ...] }
        delta_metrics JSONB NOT NULL,

        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (workspace_id, retention_prediction_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_workspace_time
        ON prediction_outcomes(workspace_id, captured_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_prediction
        ON prediction_outcomes(retention_prediction_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS prediction_outcomes`);
  },
};

export default migration;
