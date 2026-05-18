import type { Migration } from './types';

/**
 * Bridge competitor Deep Intelligence → Channel Naming
 * (per `_plans/2026-05-18-competitor-to-channel-naming-bridge.md`).
 *
 * Two unrelated columns added in one migration because they're the
 * paired persistence step that makes the bridge survive a cold load
 * (the analyze route previously held its result only in the HTTP
 * response):
 *
 *   1) competitor_channels.latest_deep_analysis_jsonb
 *      — full deep-analysis JSON from the most recent Run Deep Analysis
 *        click. Overwritten on each new run (no history table — we only
 *        need the latest for the naming prefill).
 *   2) competitor_channels.latest_deep_analysis_niche
 *      — niche string the user typed when they ran analysis. The deep
 *        analysis JSON itself has no category/niche field, so we must
 *        remember the user-supplied input to seed the naming page niche.
 *   3) competitor_channels.latest_deep_analysis_at
 *      — when it was run, surfaced as "Analyzed Xh ago" in the UI.
 *   4) saved_channel_names.source_competitor_id
 *      — the competitor whose Deep Analysis seeded this saved name, if
 *        any. ON DELETE SET NULL: saved names survive competitor deletion.
 *
 * `ensureCompetitorSchema` / `ensureChannelNamesSchema` mirror these
 * adds for hot deploys whose migration runner hasn't fired yet — the
 * first analyze / save call self-heals.
 */
const migration: Migration = {
  id: '0076_competitor_naming_bridge',
  description: 'Persist latest deep analysis on competitor_channels + link saved names back to source competitor',

  async up(client) {
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        ADD COLUMN IF NOT EXISTS latest_deep_analysis_jsonb JSONB
    `);
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        ADD COLUMN IF NOT EXISTS latest_deep_analysis_niche TEXT
    `);
    await client.query(`
      ALTER TABLE IF EXISTS competitor_channels
        ADD COLUMN IF NOT EXISTS latest_deep_analysis_at TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE IF EXISTS saved_channel_names
        ADD COLUMN IF NOT EXISTS source_competitor_id UUID
          REFERENCES competitor_channels(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_saved_names_source_competitor
        ON saved_channel_names(source_competitor_id)
        WHERE source_competitor_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_saved_names_source_competitor`);
    await client.query(`ALTER TABLE IF EXISTS saved_channel_names DROP COLUMN IF EXISTS source_competitor_id`);
    await client.query(`ALTER TABLE IF EXISTS competitor_channels DROP COLUMN IF EXISTS latest_deep_analysis_at`);
    await client.query(`ALTER TABLE IF EXISTS competitor_channels DROP COLUMN IF EXISTS latest_deep_analysis_niche`);
    await client.query(`ALTER TABLE IF EXISTS competitor_channels DROP COLUMN IF EXISTS latest_deep_analysis_jsonb`);
  },
};

export default migration;
