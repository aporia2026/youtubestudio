import type { Migration } from './types';

/**
 * Workflow triggers — "when X happens, do Y" rules + their action runs.
 *
 * A `workflow_rule` is a (trigger_event_type, condition?, action_type,
 * action_config, delay_seconds?) tuple. When an event fires anywhere
 * in the studio (A/B test concluded, cannibalization high-risk,
 * retention dip severe, etc.), the dispatcher matches every enabled
 * rule whose trigger_event_type matches, evaluates the optional
 * condition against the event payload, and creates a
 * `workflow_action_run` row scheduled for `NOW() + delay_seconds`.
 *
 * `workflow_action_runs` is the queue. A single Vercel cron endpoint
 * (POST /api/cron/run-workflows, daily on hobby) picks up due rows,
 * executes them, stamps the result.
 *
 * Why a queue instead of running synchronously off the trigger:
 *   - Decouples producers from action execution time/failures
 *   - Enables delayed actions ("snapshot 7 days after A/B concludes")
 *   - Provides an audit trail the user can review on /workflows
 *
 * The cron path is hobby-tier-friendly: daily runs are free; the queue
 * absorbs everything in between. For sub-day responsiveness, upgrade
 * to a more frequent cron (Pro tier) — no schema changes required.
 */
const migration: Migration = {
  id: '0032_create_workflows',
  description: 'Workflow triggers — rules + queued action runs',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,

        trigger_event_type TEXT NOT NULL,
        condition JSONB NOT NULL DEFAULT '{}'::jsonb,

        action_type TEXT NOT NULL,
        action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        delay_seconds INTEGER NOT NULL DEFAULT 0,

        created_by_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_fired_at TIMESTAMPTZ,
        fire_count INTEGER NOT NULL DEFAULT 0,

        CONSTRAINT workflow_rules_delay_chk CHECK (delay_seconds >= 0 AND delay_seconds <= 2592000)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_rules_workspace_event
        ON workflow_rules(workspace_id, trigger_event_type, enabled)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_action_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        rule_id UUID NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,

        trigger_event_type TEXT NOT NULL,
        trigger_event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

        scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'pending',

        action_type TEXT NOT NULL,
        action_config JSONB NOT NULL DEFAULT '{}'::jsonb,

        result JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,

        CONSTRAINT workflow_action_runs_status_chk
          CHECK (status IN ('pending','running','succeeded','failed','skipped'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_action_runs_workspace
        ON workflow_action_runs(workspace_id, created_at DESC)
    `);
    /**
     * The hot index for the cron picker — pending rows due NOW or
     * earlier, ordered by scheduled_for. Partial so it stays small
     * once most runs have completed.
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_action_runs_due
        ON workflow_action_runs(scheduled_for)
        WHERE status = 'pending'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_action_runs_rule
        ON workflow_action_runs(rule_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS workflow_action_runs`);
    await client.query(`DROP TABLE IF EXISTS workflow_rules`);
  },
};

export default migration;
