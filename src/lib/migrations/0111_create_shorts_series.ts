import type { Migration } from './types';

/**
 * Shorts everywhere v1 — Phase 15.6: Series engine.
 *
 * A "series" is a recurring Shorts identity: a name + a locked style +
 * an optional posting cadence + an optional channel link. When a Short
 * is generated under a series, the series's `locked_style_id` overrides
 * the user's style picker so a "Monday Doodle Facts" episode never
 * accidentally ships in Paint.
 *
 * Schema choices:
 *
 *   - `shorts_series` table — workspace-scoped, ON DELETE CASCADE so
 *     workspace deletion sweeps the rows. UNIQUE(workspace_id, name)
 *     so a user can't accidentally create two series with the same
 *     display name.
 *
 *   - `locked_style_id TEXT NOT NULL` — must point at an entry in
 *     `short-styles.ts`. No DB-level CHECK constraint on the enum (same
 *     posture as `shorts.style_id`): widening the TS registry should
 *     not require a migration. Bad values are caught by the
 *     application-layer validator in `shorts-series.ts`.
 *
 *   - `cadence TEXT` (nullable) — free-text human-readable cadence
 *     hint ("Mondays 9am", "weekly", "ad-hoc"). Phase 15.6 doesn't
 *     schedule anything yet — cadence is informational. The scheduled-
 *     publishing follow-up reads this column.
 *
 *   - `channel_db_id UUID` (nullable, FK ON DELETE SET NULL) — links the
 *     series to one of the workspace's OAuth-connected channels. Series
 *     can also live without a channel link (e.g. for cross-channel content
 *     planning that hasn't yet picked a destination).
 *
 *   - `intro_text` + `outro_text` (nullable) — optional copy injected
 *     at the start / end of every Short in the series. Phase 15.6
 *     stores them but doesn't yet auto-apply; the from-scratch
 *     generator reads them as additional context. The auto-apply
 *     follow-up appends them inside the extractor's prompt.
 *
 *   - `shorts.series_id UUID` (nullable FK ON DELETE SET NULL) — the
 *     link on each Short. NULL = not part of any series (the default;
 *     no behaviour change for existing rows).
 *
 * Down migration drops the FK column + table cleanly. Safe because
 * the schema is additive — pre-0111 callers don't reference these.
 */
const migration: Migration = {
  id: '0111_create_shorts_series',
  description: 'shorts_series table + shorts.series_id FK for the Phase 15.6 Series engine',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS shorts_series (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        locked_style_id TEXT NOT NULL,
        cadence         TEXT,
        channel_db_id   UUID REFERENCES channels(id) ON DELETE SET NULL,
        intro_text      TEXT,
        outro_text      TEXT,
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT shorts_series_workspace_name_unique UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_series_workspace
        ON shorts_series(workspace_id, created_at DESC)
    `);
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES shorts_series(id) ON DELETE SET NULL`,
    );
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_series_id
        ON shorts(series_id) WHERE series_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_shorts_series_id`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS series_id`);
    await client.query(`DROP INDEX IF EXISTS idx_shorts_series_workspace`);
    await client.query(`DROP TABLE IF EXISTS shorts_series`);
  },
};

export default migration;
