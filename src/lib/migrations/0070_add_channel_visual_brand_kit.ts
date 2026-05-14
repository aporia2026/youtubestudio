import type { Migration } from './types';

/**
 * Add a JSONB `visual_brand_kit` column to `channels`. Stores per-channel
 * default visual styling (fonts, colors, logo URL, channel name) used by
 * the Remotion video composition.
 *
 * Sibling to the existing `brand_kit` column (added in 0016 — that one
 * carries voice / tone / phrase guidance for script generation). The two
 * concerns are deliberately separated so reading one as the other is a
 * category mistake the type system rules out.
 *
 * Defaults to '{}' so every existing channel starts with an empty kit
 * and the render-time resolver falls through to DEFAULT_BRAND_KIT.
 *
 * `ALTER TABLE IF EXISTS` keeps the migration safe on a never-booted DB.
 * The column is NOT NULL only because the default is provided — a row
 * without a kit is the same as a row with `{}` for the resolver.
 */
const migration: Migration = {
  id: '0070_add_channel_visual_brand_kit',
  description: 'Add visual_brand_kit JSONB column to channels for per-channel font / color / logo defaults',

  async up(client) {
    await client.query(
      `ALTER TABLE IF EXISTS channels ADD COLUMN IF NOT EXISTS visual_brand_kit JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE IF EXISTS channels DROP COLUMN IF EXISTS visual_brand_kit`);
  },
};

export default migration;
