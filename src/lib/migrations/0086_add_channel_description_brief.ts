import type { Migration } from './types';

/**
 * Add a `description_brief` TEXT column to `channels`. Stores the free-form
 * brief the user typed into the AI description generator, so the next time
 * they open the channel's description page the brief is prefilled and
 * iteration is one click away.
 *
 * Defaults to NULL — existing channels start with no brief, which is the
 * same state as a brand-new channel that hasn't run the generator yet.
 *
 * Paired with the hot-path bootstrap in src/lib/db.ts so deploys that hit
 * code referencing the column before the migration runner has fired still
 * see a populated schema.
 */
const migration: Migration = {
  id: '0086_add_channel_description_brief',
  description: 'Add description_brief TEXT column to channels for the AI description generator',

  async up(client) {
    await client.query(
      `ALTER TABLE IF EXISTS channels ADD COLUMN IF NOT EXISTS description_brief TEXT`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE IF EXISTS channels DROP COLUMN IF EXISTS description_brief`);
  },
};

export default migration;
