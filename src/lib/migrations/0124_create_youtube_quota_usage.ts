import type { Migration } from './types';

/**
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Lightweight per-channel-per-UTC-day counter for YouTube Data API
 * quota charges. We track our own charges so the UI can render a
 * "remaining quota today" meter and refuse to start a batch upload
 * that would breach the day's budget.
 *
 * This is intentionally APPROXIMATE — Google is the authoritative
 * source. Two things can drift the counter:
 *   1. Other systems (other deployments, manual API calls) burning
 *      from the same Google Cloud project's quota.
 *   2. Failed inserts that still cost quota (a few edge cases).
 * The uploader is conservative: it records the charge BEFORE the
 * API call, so a failure costs the counter (matches Google's
 * behavior for quota — failed requests are still charged).
 *
 * Schema:
 *   - (channel_id, utc_date) is the unique key. One row per channel
 *     per day. Rolls over naturally at UTC midnight.
 *   - `units_charged` is the running total. Default daily quota is
 *     10,000 — UI compares to a constant for "remaining". The
 *     constant lives in code, not here, so a quota bump from Google
 *     doesn't need a migration.
 *   - `charge_count` is informational: lets the UI render "8
 *     uploads today" alongside the units number.
 *
 * Indexes: PK covers the common read (lookup by channel + day).
 * No additional indexes needed at MVP scale.
 *
 * Down: drop the table.
 */
const migration: Migration = {
  id: '0124_create_youtube_quota_usage',
  description: 'Per-channel-per-day YouTube Data API quota charge counter',

  async up(client) {
    await client.query(`
      CREATE TABLE youtube_quota_usage (
        channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        utc_date        DATE NOT NULL,
        units_charged   INTEGER NOT NULL DEFAULT 0,
        charge_count    INTEGER NOT NULL DEFAULT 0,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (channel_id, utc_date)
      )
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS youtube_quota_usage`);
  },
};

export default migration;
