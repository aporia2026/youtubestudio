import type { Migration } from './types';

/**
 * Plan: `_plans/2026-06-05-channel-clone-pipeline.md`.
 *
 * Channel-clone takes a competitor YouTube URL and walks it through
 * 8 LLM stages (intake → analyze → topic → hook → script → audit →
 * rowify → publish-pack) to produce a ready-to-render production-doc
 * draft. Each clone run needs persistent state because the workflow
 * spans many minutes of subprocess work (yt-dlp + ffmpeg) and
 * model-call work — losing it on a refresh would burn the user's
 * intake spend.
 *
 * Why a new table instead of piggybacking on `pipeline_run_videos`:
 *   - Pipeline-run-videos are the *output* of a clone run; the
 *     channel-clone job is the bootstrap that produces them. Mixing
 *     bootstrap state into a video row pollutes the stage-machine
 *     semantics (queued → generating_idea → … → done) that the cron
 *     dispatcher relies on. Keeping the bootstrap separate means the
 *     existing pipeline doesn't have to learn anything new — once
 *     channel-clone produces an approved script, it spawns a normal
 *     pipeline_run_videos row and the cron picks it up.
 *   - Workspace-scoped like every other domain table per the post-
 *     0011 invariant.
 *
 * `state_jsonb` shape is documented by `ChannelCloneJobState` in
 * `src/lib/channel-clone/types.ts`. JSONB instead of normalised
 * columns because the per-stage shapes are heterogeneous (intake
 * stores video paths + frame paths; analyze stores nested style-DNA
 * objects; audit stores an array of revision iterations) and shipping
 * them as one blob keeps the migration story simple as the pipeline
 * evolves through M2–M5.
 *
 * Indexes:
 *   - workspace + updated_at DESC for the most common list query
 *     ("show me my recent clone jobs"). Composite, not two separate
 *     indexes, because list always filters by workspace.
 *   - status alone covers cron sweeps that may scan for jobs in a
 *     given state across workspaces (admin debug).
 *
 * Down migration drops the table and its indexes — there's no
 * downstream FK so the drop is clean. Channel-clone is a self-
 * contained feature; nothing else in the schema points at this table.
 */
const migration: Migration = {
  id: '0119_create_channel_clone_jobs',
  description: 'Create channel_clone_jobs — bootstrap state for the channel-clone pipeline that turns a competitor YouTube URL into a production-doc draft',

  async up(client) {
    await client.query(`
      CREATE TABLE channel_clone_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL,
        user_id UUID NOT NULL,
        source_channel_url TEXT NOT NULL,
        source_canonical_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'intake_pending',
        state_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX channel_clone_jobs_workspace_updated_idx
        ON channel_clone_jobs (workspace_id, updated_at DESC)
    `);
    await client.query(`
      CREATE INDEX channel_clone_jobs_status_idx
        ON channel_clone_jobs (status)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS channel_clone_jobs_status_idx`);
    await client.query(`DROP INDEX IF EXISTS channel_clone_jobs_workspace_updated_idx`);
    await client.query(`DROP TABLE IF EXISTS channel_clone_jobs`);
  },
};

export default migration;
