import type { Migration } from './types';

/**
 * Cross-channel cannibalization alerts.
 *
 * For multi-channel YouTubers: detects when two of the workspace's
 * channels are about to publish (or recently published) videos that
 * compete for the same audience — same niche, similar title, same
 * 7-day window. The classic failure mode is two of your channels
 * fighting over the same query and both losing half their traffic.
 *
 * One row per detected PAIR. Each "side" of the pair can be either a
 * scheduled `schedule_item` or an already-published `video_analytics`
 * row (so we can flag "your scheduled video next Tuesday will compete
 * with the one you published last Friday on your other channel").
 *
 * `status` flips active → dismissed when the user explicitly clears
 * the alert (we keep the row so re-scans don't re-flag the same pair
 * over and over).
 */
const migration: Migration = {
  id: '0028_create_cannibalization_alerts',
  description: 'Cross-channel cannibalization alerts (overlap detection between scheduled + published videos)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cannibalization_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        scope_window_start TIMESTAMPTZ NOT NULL,
        scope_window_end TIMESTAMPTZ NOT NULL,

        -- Pair side A
        pair_a_kind TEXT NOT NULL,
        pair_a_ref_id TEXT NOT NULL,
        pair_a_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        pair_a_channel_name TEXT,
        pair_a_title TEXT NOT NULL,
        pair_a_publish_at TIMESTAMPTZ,

        -- Pair side B
        pair_b_kind TEXT NOT NULL,
        pair_b_ref_id TEXT NOT NULL,
        pair_b_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        pair_b_channel_name TEXT,
        pair_b_title TEXT NOT NULL,
        pair_b_publish_at TIMESTAMPTZ,

        similarity_score NUMERIC(4,3) NOT NULL,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        why TEXT,
        recommended_fix TEXT,

        status TEXT NOT NULL DEFAULT 'active',
        dismissed_at TIMESTAMPTZ,

        ai_model TEXT,
        notes TEXT,

        CONSTRAINT cannibalization_alerts_kind_a_chk
          CHECK (pair_a_kind IN ('schedule_item','video')),
        CONSTRAINT cannibalization_alerts_kind_b_chk
          CHECK (pair_b_kind IN ('schedule_item','video')),
        CONSTRAINT cannibalization_alerts_risk_chk
          CHECK (risk_level IN ('low','medium','high')),
        CONSTRAINT cannibalization_alerts_status_chk
          CHECK (status IN ('active','dismissed'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cannibalization_alerts_workspace
        ON cannibalization_alerts(workspace_id, detected_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cannibalization_alerts_active
        ON cannibalization_alerts(workspace_id, detected_at DESC) WHERE status = 'active'
    `);
    // Dedup index — re-running a scan should NOT create duplicate active
    // alerts for the same pair. The route uses ON CONFLICT to skip dupes;
    // this index makes the dedup check fast and enforces it at the DB.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cannibalization_alerts_dedup
        ON cannibalization_alerts(workspace_id, pair_a_ref_id, pair_b_ref_id)
        WHERE status = 'active'
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS cannibalization_alerts`);
  },
};

export default migration;
