import type { Migration } from './types';

/**
 * Review-player timing samples (Phase 2 measurement step of
 * `_plans/2026-05-14-review-timing-aggregation.md`).
 *
 * Captures one row per ReviewPlayer cold-start completion (or unmount),
 * so we can compute aggregated p50/p95 time-to-first-frame and decide
 * whether the HLS adaptive-streaming Phase 2 (≈$0.29/video transcode
 * cost) is actually warranted on real-reviewer networks. The Phase 2
 * HLS plan is gated on this data: skip HLS if reviewer-side p50 < 2.5s
 * and p95 < 8s over a one-week window.
 *
 * Storage envelope: at most a few hundred samples a day across the
 * team; over a week the table holds well under 10 KB. No retention job
 * in this migration — revisit if the instrumentation outlives the
 * measurement window.
 *
 * Soft FK on `version_id` (no constraint): capture must never fail
 * because the underlying version was deleted between sample collection
 * and the POST landing. The aggregation query reads the column directly
 * and doesn't need referential integrity.
 *
 * Privacy: no IP, no user-agent, no reviewer identity. `was_owner` is
 * the only identity-ish bit — necessary so the owner's fast connection
 * doesn't skew the reviewer-side numbers we actually care about.
 */
const migration: Migration = {
  id: '0069_create_review_player_timing_samples',
  description: 'Review-player cold-start timing samples (drives the HLS Phase 2 greenlight/skip decision)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS review_player_timing_samples (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        version_id                UUID NOT NULL,
        was_owner                 BOOLEAN NOT NULL,
        time_to_metadata_ms       INTEGER,
        time_to_first_frame_ms    INTEGER,
        time_to_canplaythrough_ms INTEGER,
        stall_count               SMALLINT NOT NULL DEFAULT 0,
        total_stall_ms            INTEGER NOT NULL DEFAULT 0,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Supports the windowed aggregate the admin summary endpoint
    // performs (`WHERE created_at >= now() - INTERVAL 'N days'`).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_review_player_timing_samples_created_at
        ON review_player_timing_samples (created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS review_player_timing_samples`);
  },
};

export default migration;
