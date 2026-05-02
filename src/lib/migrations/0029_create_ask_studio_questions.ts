import type { Migration } from './types';

/**
 * "Ask Studio" — natural-language questions over the user's own data.
 *
 * One row per question. The model runs a tool-use loop over a curated
 * catalog of read-only queries (channels, video_analytics, schedule_items,
 * projects, ab_tests, etc.) — each tool is workspace-auto-scoped so the
 * model literally can't query across tenants no matter what it tries.
 *
 * Tool calls + their JSON results are persisted in `tool_trace` so the
 * user can audit how the model arrived at the answer (and so future
 * sessions can learn which queries are actually useful vs. noise).
 *
 * `error_message` set when the agent loop fails (model error, tool
 * error, or timeout). `answer` is null when error_message is set.
 */
const migration: Migration = {
  id: '0029_create_ask_studio_questions',
  description: '"Ask Studio" agent — natural-language Q&A over the workspace\'s own data',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ask_studio_questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        asked_by_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,

        question TEXT NOT NULL,
        answer TEXT,
        error_message TEXT,

        tool_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
        tool_call_count INTEGER NOT NULL DEFAULT 0,

        ai_model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        duration_ms INTEGER,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ask_studio_questions_workspace
        ON ask_studio_questions(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ask_studio_questions_asker
        ON ask_studio_questions(asked_by_collaborator_id, created_at DESC)
        WHERE asked_by_collaborator_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS ask_studio_questions`);
  },
};

export default migration;
