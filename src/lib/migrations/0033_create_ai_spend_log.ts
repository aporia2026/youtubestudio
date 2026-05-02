import type { Migration } from './types';

/**
 * Per-call AI spend log. One row per billable model invocation.
 *
 * Wired through `generateText` in src/lib/ai.ts: callers pass an
 * optional `spend` context, and on a successful generation the Anthropic
 * / OpenAI / Google branches stamp usage tokens here. Cost is computed
 * at log time from `src/lib/ai-pricing.ts` so historical rows freeze
 * the pricing that applied — re-pricing later requires running a
 * recompute pass, NOT mutating the table in place.
 *
 * `feature_area` is a free-text label the caller supplies (e.g.
 * 'critic_panel', 'retention_predictor', 'comment_triage'). The /spend
 * page groups by it.
 *
 * `provider` is one of 'anthropic' | 'openai' | 'google' | 'kie' |
 * 'elevenlabs'. Stored as TEXT (no enum) so adding providers doesn't
 * need a migration.
 *
 * `project_id` and `channel_db_id` are nullable — many AI calls aren't
 * scoped to a single project (e.g. cannibalization scan looks at the
 * whole workspace). When set, the dashboard can attribute cost to a
 * specific channel's content pipeline.
 */
const migration: Migration = {
  id: '0033_create_ai_spend_log',
  description: 'Per-call AI spend log — token usage + cost in USD per generateText invocation',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_spend_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        channel_db_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        feature_area TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,

        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,

        cost_usd_input NUMERIC(12,6) NOT NULL DEFAULT 0,
        cost_usd_output NUMERIC(12,6) NOT NULL DEFAULT 0,
        cost_usd_total NUMERIC(12,6) NOT NULL DEFAULT 0,

        duration_ms INTEGER,
        request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /**
     * Workspace + time index — primary read path is "spend in the last
     * 30 days for this workspace, grouped by something".
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_spend_log_workspace_time
        ON ai_spend_log(workspace_id, occurred_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_spend_log_project
        ON ai_spend_log(project_id, occurred_at DESC) WHERE project_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_spend_log_feature
        ON ai_spend_log(workspace_id, feature_area, occurred_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS ai_spend_log`);
  },
};

export default migration;
