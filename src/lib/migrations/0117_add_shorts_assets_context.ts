import type { Migration } from './types';

/**
 * Plan: `_plans/2026-06-04-shorts-captions-position-and-assets-context.md`.
 *
 * Adds `shorts.assets_context` — optional free-text the creator types into
 * the Short editor to steer the Doodle/Paint asset planner (e.g. "the
 * character is a kid, not an adult", "set everything in a kitchen"). The
 * cron threads this into the planner prompt above the script so the LLM
 * treats it as a hard creator brief rather than loose inspiration.
 *
 * Nullable on purpose: existing rows pre-date the column and read as "no
 * extra context", which the planner handles by omitting the block entirely.
 * No backfill needed.
 */
const migration: Migration = {
  id: '0117_add_shorts_assets_context',
  description: 'shorts.assets_context TEXT (nullable) — creator-supplied prompt steer for the Doodle/Paint asset planner',

  async up(client) {
    await client.query(`
      ALTER TABLE shorts
        ADD COLUMN IF NOT EXISTS assets_context TEXT
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE shorts DROP COLUMN IF EXISTS assets_context
    `);
  },
};

export default migration;
