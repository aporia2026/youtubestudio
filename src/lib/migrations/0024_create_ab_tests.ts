import type { Migration } from './types';

/**
 * Native YouTube A/B testing for title + thumbnail.
 *
 * YouTube's "Test & Compare" thumbnails feature exists in YouTube Studio's
 * UI but has no public Data API surface (as of May 2026). Our approach is
 * therefore manual: store two variants per video (A + B), let the user
 * swap which one is live via `youtube.videos.update` + `thumbnails.set`,
 * and snapshot YouTube Analytics metrics around each swap so the
 * post-test comparison is honest.
 *
 * `ab_test_snapshots` is append-only — every Take Snapshot click writes a
 * new row stamped with which variant was live at the time. The detail
 * page aggregates by variant to compute "while A was live: 12.4% CTR".
 *
 * `schedule_item_id` ON DELETE SET NULL: A/B tests outlive the schedule
 * item that spawned them (the test history is the more durable artifact).
 * `youtube_video_id` is the join key into `video_analytics`.
 */
const migration: Migration = {
  id: '0024_create_ab_tests',
  description: 'Native YouTube A/B title + thumbnail tests with append-only metrics snapshots',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        schedule_item_id UUID REFERENCES schedule_items(id) ON DELETE SET NULL,
        channel_db_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        youtube_video_id TEXT NOT NULL,

        variant_a_title TEXT NOT NULL,
        variant_a_thumbnail_url TEXT,
        variant_b_title TEXT NOT NULL,
        variant_b_thumbnail_url TEXT,

        live_variant CHAR(1) NOT NULL DEFAULT 'a',
        winner CHAR(1),
        status TEXT NOT NULL DEFAULT 'draft',

        ai_model TEXT,
        notes TEXT,

        started_at TIMESTAMPTZ,
        last_swapped_at TIMESTAMPTZ,
        concluded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT ab_tests_live_variant_chk CHECK (live_variant IN ('a','b')),
        CONSTRAINT ab_tests_winner_chk CHECK (winner IS NULL OR winner IN ('a','b')),
        CONSTRAINT ab_tests_status_chk CHECK (status IN ('draft','running','concluded'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_workspace
        ON ab_tests(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_schedule_item
        ON ab_tests(schedule_item_id) WHERE schedule_item_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_video
        ON ab_tests(workspace_id, youtube_video_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ab_test_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        ab_test_id UUID NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE,

        variant CHAR(1) NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        impressions BIGINT,
        views BIGINT,
        ctr_percentage NUMERIC(6,3),
        average_view_duration_seconds INTEGER,
        average_view_percentage NUMERIC(6,3),
        subscribers_gained INTEGER,

        raw JSONB NOT NULL DEFAULT '{}'::jsonb,

        CONSTRAINT ab_test_snapshots_variant_chk CHECK (variant IN ('a','b'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_test_snapshots_test
        ON ab_test_snapshots(ab_test_id, captured_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_test_snapshots_workspace
        ON ab_test_snapshots(workspace_id, captured_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS ab_test_snapshots`);
    await client.query(`DROP TABLE IF EXISTS ab_tests`);
  },
};

export default migration;
