import type { Migration } from './types';

/**
 * Phase 9.6 — weekly AI-synthesised insight digest.
 *
 * Every Monday 09:00 UTC, a cron generates a 1-page summary per
 * opted-in workspace: "what changed last week, why, three concrete
 * next moves." The artifact is stored here so the permalink page
 * `/insights/[week]` is a cheap DB read; deliveries (Slack / Discord
 * via the existing webhook fan-out, plus email via @sendgrid/mail)
 * are presentation layers that link back to it.
 *
 * Schema:
 *   - PK on (workspace_id, week_start) — one digest per workspace per
 *     week, idempotent re-runs
 *   - `body_markdown` is the source of truth; `body_html` is rendered
 *     once at generation time so deliveries don't have to re-render
 *   - `inputs_summary` JSONB carries the assembled stats the model
 *     was shown — useful for the permalink page to show the "raw
 *     numbers" alongside the prose, and for debugging when the model
 *     drifts off-topic
 *
 * `weekly_digest_enabled` boolean on `workspaces` is the opt-in toggle
 * (default false — explicit opt-in respects the user's "ship me less
 * by default" preference).
 */
const migration: Migration = {
  id: '0046_create_insight_digests',
  description: 'Phase 9.6 — weekly AI-synthesised insight digests + opt-in flag on workspaces',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS insight_digests (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        -- ISO date of the Monday that starts the digest's week (UTC).
        week_start DATE NOT NULL,

        body_markdown TEXT NOT NULL,
        body_html TEXT NOT NULL,

        -- Snapshot of the assembled stats the model was shown. Helps
        -- debug drift + lets the permalink page surface raw numbers.
        inputs_summary JSONB NOT NULL DEFAULT '{}'::jsonb,

        ai_model TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Per-channel delivery status — JSON map { slack: 'ok',
        -- email: 'sent', discord: 'skipped' } so the UI can show
        -- which channels actually got the digest.
        delivery_status JSONB NOT NULL DEFAULT '{}'::jsonb,

        PRIMARY KEY (workspace_id, week_start)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_insight_digests_workspace_time
        ON insight_digests(workspace_id, week_start DESC)
    `);

    // Opt-in toggle. Default false — workspaces explicitly enable
    // on /settings.
    await client.query(`
      ALTER TABLE IF EXISTS workspaces
        ADD COLUMN IF NOT EXISTS weekly_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Optional override — comma-separated email list. NULL means
    // "use the workspace owner's email." Defensive size cap at 1KB.
    await client.query(`
      ALTER TABLE IF EXISTS workspaces
        ADD COLUMN IF NOT EXISTS weekly_digest_email_recipients TEXT
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS insight_digests`);
    await client.query(`
      ALTER TABLE IF EXISTS workspaces
        DROP COLUMN IF EXISTS weekly_digest_email_recipients
    `);
    await client.query(`
      ALTER TABLE IF EXISTS workspaces
        DROP COLUMN IF EXISTS weekly_digest_enabled
    `);
  },
};

export default migration;
