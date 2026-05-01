import type { Migration } from './types';

/**
 * Add a JSONB `brand_kit` column to `channels`. Stores per-channel voice /
 * tone / banned-phrase / hook-style guidance that auto-pipes into every
 * script-generation prompt when that channel is the active one.
 *
 * Defaults to '{}' so every existing channel starts with an empty kit and
 * the prompt-block builder produces no output for it.
 *
 * `ALTER TABLE IF EXISTS` keeps the migration safe on a never-booted DB.
 * The column is intentionally not NOT-NULL — a row without a kit is the
 * same as a row with `{}` for the prompt-block builder.
 */
const migration: Migration = {
  id: '0016_add_channel_brand_kit',
  description: 'Add brand_kit JSONB column to channels for per-channel voice / tone / phrase guidance',

  async up(client) {
    await client.query(
      `ALTER TABLE IF EXISTS channels ADD COLUMN IF NOT EXISTS brand_kit JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE IF EXISTS channels DROP COLUMN IF EXISTS brand_kit`);
  },
};

export default migration;
