import type { Migration } from './types';

/**
 * Phase 13.2.W — saved-niche watchlist with weekly re-scoring history.
 *
 * One row per (workspace, niche). PK is `(workspace_id, niche_slug)`
 * so re-saving is idempotent. `weekly_history` is a JSONB array of
 * up to 26 snapshots (~6 months at one per week); each snapshot
 * carries the niche's combined score + per-dimension labels at that
 * moment so the UI can render a 6-month sparkline without joining
 * across other tables. The cron is responsible for trimming the
 * head when the array exceeds 26 entries.
 *
 * `alarm_threshold` is the combined-score delta beyond which the
 * cron fires the `niche_score_spike` workflow event. Default 0.10
 * (a roughly 10% jump on the combined score). NULL disables alarms.
 *
 * Re-scoring re-uses the v0.5 deep-dive orchestrator, so the
 * `niche_reports` row stays current at the same time.
 */
const migration: Migration = {
  id: '0059_create_niche_watchlist',
  description: 'Phase 13.2.W — saved-niche watchlist with weekly history',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_watchlist (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        niche_slug TEXT NOT NULL,

        -- Display name — kept in sync with niche_reports.name on each
        -- re-score so the UI doesn't have to join.
        niche_name TEXT NOT NULL,

        -- Array of { captured_at, combined, demand_label, supply_label,
        --   monetization_label, monetization_low_usd, monetization_high_usd,
        --   fit_label }
        -- Trimmed to 26 entries on each cron tick.
        weekly_history JSONB NOT NULL DEFAULT '[]'::jsonb,

        -- Combined-score delta (0..1) above which the cron fires
        -- niche_score_spike. NULL means the watchlist row never
        -- triggers a workflow event (passive tracking only).
        alarm_threshold NUMERIC(4,3) DEFAULT 0.100,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_rescored_at TIMESTAMPTZ,

        PRIMARY KEY (workspace_id, niche_slug)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_watchlist_workspace_time
        ON niche_watchlist(workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS niche_watchlist`);
  },
};

export default migration;
