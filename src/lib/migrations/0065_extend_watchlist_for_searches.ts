import type { Migration } from './types';

/**
 * Phase 13.2.W follow-up — extend `niche_watchlist` to also store
 * saved Browse-Categories filter specs.
 *
 * A saved search is "the filter dial the user had set when they
 * clicked Save", stored as a JSON blob. Running it later replays the
 * filter against currently-cached taxonomy scores (no AI / no YouTube
 * cost) and returns matching niches the user can one-click add to the
 * watchlist proper.
 *
 * The user picked "extend the existing watchlist" over a new table
 * during planning (rule 4 alternative-with-recommendation) — one
 * mental model on the watchlist page, half the code, no new entity to
 * learn. Implementation trick: saved-search rows reuse the existing PK
 * `(workspace_id, niche_slug)` by stuffing a synthetic slug
 * `search-<uuid>` into `niche_slug`. The new `kind` column
 * disambiguates the two row shapes for everything else. Pre-existing
 * rows back-fill to `kind='niche'` so the watchlist page keeps
 * rendering them.
 *
 * The unused-for-searches columns (`weekly_history`,
 * `alarm_threshold`) stay defaulted/null on search rows. Slight schema
 * waste, but it keeps the existing niche-row CRUD untouched.
 */
const migration: Migration = {
  id: '0065_extend_watchlist_for_searches',
  description: 'Phase 13.2 follow-up — saved Browse Categories filter searches via niche_watchlist',

  async up(client) {
    await client.query(`
      ALTER TABLE niche_watchlist
        ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'niche'
          CHECK (kind IN ('niche', 'search'))
    `);
    await client.query(`
      ALTER TABLE niche_watchlist
        ADD COLUMN IF NOT EXISTS search_spec JSONB
    `);
    await client.query(`
      ALTER TABLE niche_watchlist
        ADD COLUMN IF NOT EXISTS search_label TEXT
    `);
    await client.query(`
      ALTER TABLE niche_watchlist
        ADD COLUMN IF NOT EXISTS last_match_count INTEGER
    `);

    // The watchlist listing routes filter by kind, so a per-workspace
    // (kind, created_at) index keeps both flavours fast.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_watchlist_workspace_kind_time
        ON niche_watchlist(workspace_id, kind, created_at DESC)
    `);
  },

  async down(client) {
    // The index drop is safe because the original 0059 index
    // `idx_niche_watchlist_workspace_time` is untouched.
    await client.query(`DROP INDEX IF EXISTS idx_niche_watchlist_workspace_kind_time`);
    await client.query(`ALTER TABLE niche_watchlist DROP COLUMN IF EXISTS last_match_count`);
    await client.query(`ALTER TABLE niche_watchlist DROP COLUMN IF EXISTS search_label`);
    await client.query(`ALTER TABLE niche_watchlist DROP COLUMN IF EXISTS search_spec`);
    await client.query(`ALTER TABLE niche_watchlist DROP COLUMN IF EXISTS kind`);
  },
};

export default migration;
