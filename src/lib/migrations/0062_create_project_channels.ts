import type { Migration } from './types';

/**
 * Phase 1 of the channel-assignment-everywhere plan
 * (`_plans/2026-05-13-channel-assignment-everywhere.md`).
 *
 * `projects` becomes the channel anchor for every artifact that lives under
 * it (scripts, voiceovers, B-roll, critic panels, reviews, narrator takes,
 * shorts). A many-to-many join lets a single project target multiple
 * channels, matching the schedule_item_channels pattern so cross-posting
 * works the same way it does on the schedule.
 *
 * Design notes:
 *   - Composite PK (project_id, channel_id) prevents duplicate links and
 *     gives the upsert `ON CONFLICT DO NOTHING` a natural target. Postgres
 *     auto-indexes the PK, which doubles as the lookup-by-project index.
 *   - Lookup-by-channel needs its own index — the filter-by-channel UI in
 *     Phase 2 will run `WHERE channel_id = $1`. The PK column order makes
 *     this query unindexed without it.
 *   - Workspace scoping is derived: project_channels rows are reachable
 *     only via projects.workspace_id (and channels.workspace_id). No own
 *     workspace_id column on the join — keeps the table lean and aligns
 *     with schedule_item_channels.
 *   - CASCADE on both FKs means a deleted project, channel, or workspace
 *     (which cascades to projects + channels) sweeps its join rows.
 */
const migration: Migration = {
  id: '0062_create_project_channels',
  description: 'Many-to-many project_channels join table — projects become the channel anchor for all downstream artifacts',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_channels (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, channel_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_channels_channel
        ON project_channels(channel_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS project_channels`);
  },
};

export default migration;
