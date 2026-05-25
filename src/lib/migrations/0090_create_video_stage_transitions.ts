import type { Migration } from './types';

/**
 * Telemetry table: every time a video changes stage (manual advance from the
 * VideoContextStrip, drag-to-advance on the Command Center kanban, auto-pipeline
 * cron tick, narrator portal mark-done, editor portal mark-done), one row is
 * appended here.
 *
 * Why a separate append-only table instead of a column on projects: stages
 * already live in five places (projects.status, schedule_items.status,
 * pipeline_run_videos.stage, narrator_assignments.status,
 * editor_assignments.status). This table is the one canonical record of
 * "what stage moved when, who did it, by which path." It powers:
 *
 *   - The Command Center "stuck videos" panel (videos with no recent
 *     transition).
 *   - Per-stage telemetry for the QA hardening plan (where do scripts
 *     die in the funnel?).
 *   - The Wave 3 unification: the backfill that populates
 *     projects.current_stage is just "for each project, take the
 *     latest video_stage_transitions.to_stage."
 *   - Cheap "Activity" view of the video's history.
 *
 * Indexes:
 *   - (project_id, occurred_at DESC) for the per-video timeline view
 *     and stuck-detection query.
 *   - (workspace_id, occurred_at DESC) for workspace-wide telemetry
 *     dashboards (added in the QA hardening plan).
 *
 * No ON DELETE rule on the soft FK to projects — keeping orphan
 * transitions after a project is deleted is intentional so the audit
 * trail survives a destructive operation. workspace_id CASCADEs so
 * workspace teardown still cleans up.
 */
const migration: Migration = {
  id: '0090_create_video_stage_transitions',
  description: 'Append-only telemetry for video stage transitions (powers stuck detection + per-stage analytics + Wave 3 backfill)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_stage_transitions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id      UUID NOT NULL,
        from_stage      TEXT,
        to_stage        TEXT NOT NULL,
        source          TEXT NOT NULL,
        actor_user_id   UUID,
        actor_label     TEXT,
        note            TEXT,
        occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Per-video timeline + the stuck-detection query both order by occurred_at
    // DESC, so the index covers both. project_id leads because every query
    // either filters by it or groups by it.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_stage_transitions_project_time
        ON video_stage_transitions (project_id, occurred_at DESC)
    `);

    // Workspace-wide telemetry — used by stuck detection ("any video in
    // workspace W that hasn't moved in N hours") and by the Command Center
    // stats. Keeps it small with workspace_id leading.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_stage_transitions_workspace_time
        ON video_stage_transitions (workspace_id, occurred_at DESC)
    `);

    // Source-breakdown index: "how many transitions came from the cron vs the
    // user's manual advances this week?" Cheap on disk (TEXT enum-ish column),
    // pays back the QA-hardening telemetry queries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_stage_transitions_source
        ON video_stage_transitions (workspace_id, source, occurred_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_stage_transitions`);
  },
};

export default migration;
