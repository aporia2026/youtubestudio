import type { Migration } from './types';

/**
 * Pre-publish retention-curve predictions for scripts.
 *
 * The model takes a script + niche + a small few-shot of the workspace's
 * own past videos (script ↔ real retention_curve pairs from the
 * `video_analytics` table) and predicts what shape the audience-retention
 * graph will take when this script is published.
 *
 * The prediction includes:
 *   - `predicted_curve` — same shape as `video_analytics.retention_curve`
 *     (array of { position 0-1, retention 0-1 }); same shape so the
 *     existing visualization component can render it without a fork
 *   - `predicted_avd_percentage` — predicted average view percentage
 *   - `segment_explanations` — per-script-section "this segment will lose
 *     X% of viewers because Y; fix by Z"
 *   - `few_shot_video_ids` — which past videos were used as RAG context
 *     so the prediction is auditable
 *
 * `source_script_id` ON DELETE SET NULL — predictions are durable
 * artifacts (the user wants to compare prediction vs reality even after
 * the script is deleted).
 *
 * `channel_db_id` is not a hard FK to `channels.id` because the user can
 * predict for "any channel"; we just record which channel scoped the
 * few-shot retrieval for reproducibility.
 */
const migration: Migration = {
  id: '0026_create_retention_predictions',
  description: 'Pre-publish retention-curve predictions (RAG over the workspace\'s own video history)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS retention_predictions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        source_script_id UUID REFERENCES scripts(id) ON DELETE SET NULL,
        channel_db_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        script_text TEXT NOT NULL,
        niche TEXT,
        word_count INTEGER,
        estimated_duration_seconds INTEGER,

        predicted_curve JSONB NOT NULL DEFAULT '[]'::jsonb,
        predicted_avd_percentage NUMERIC(6,3),
        predicted_avd_seconds INTEGER,

        segment_explanations JSONB NOT NULL DEFAULT '[]'::jsonb,
        biggest_drop JSONB,
        suggested_fixes JSONB NOT NULL DEFAULT '[]'::jsonb,

        few_shot_video_ids TEXT[] NOT NULL DEFAULT '{}',
        few_shot_count INTEGER NOT NULL DEFAULT 0,

        ai_model TEXT NOT NULL,
        generation_params JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retention_predictions_workspace
        ON retention_predictions(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retention_predictions_project
        ON retention_predictions(project_id) WHERE project_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retention_predictions_script
        ON retention_predictions(source_script_id) WHERE source_script_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS retention_predictions`);
  },
};

export default migration;
