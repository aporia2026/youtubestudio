import type { Migration } from './types';

/**
 * Wave 3 of the Command Center plan
 * (`_plans/2026-05-26-command-center-and-cross-feature-context.md`).
 *
 * Adds a cached `current_stage` column on `projects`. This is the
 * destination of the data-unification work: every stage-changing path
 * (the auto-pipeline cron, the kanban drag, the narrator/editor portal
 * mark-done, the QA gate) eventually funnels through `advanceVideo()`
 * which writes this column. The three legacy state-machine columns
 * (`projects.status`, `pipeline_run_videos.stage`,
 * `schedule_items.status`) stay in place as projections.
 *
 * Why a cached column instead of a DB view: the Command Center kanban
 * does a per-row LATERAL join across 6+ tables to resolve the stage
 * today. With the cache, the same query becomes a simple `SELECT
 * current_stage` on the projects row, which makes the page noticeably
 * faster as the workspace grows.
 *
 * Nullable on purpose: NULL means "not yet computed" so the
 * back-compat code path (resolve via joins) still runs for any row
 * that hasn't been touched by `advanceVideo()` yet. The backfill
 * script in `scripts/backfill-project-current-stage.ts` does an
 * initial population once this migration ships.
 *
 * TEXT (not enum) so the value tracks the freeform `VideoStageId`
 * union in `src/lib/video-stages.ts` without a schema migration each
 * time we add a stage. Application-level validation is the gate.
 *
 * Index keeps the workspace-wide `WHERE workspace_id = $1 AND
 * current_stage = $2` query fast — the Command Center column-count
 * lookup uses exactly this shape.
 */
const migration: Migration = {
  id: '0091_add_projects_current_stage',
  description: 'Cached current_stage column on projects (Wave 3 of the Command Center data unification)',

  async up(client) {
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS current_stage TEXT
    `);

    // Workspace + stage composite index for the kanban grouping query.
    // Partial index (WHERE current_stage IS NOT NULL) keeps it lean —
    // until backfill completes, half the rows have NULL and an index
    // on those wastes space.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_workspace_current_stage
        ON projects (workspace_id, current_stage)
        WHERE current_stage IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_projects_workspace_current_stage`);
    await client.query(`ALTER TABLE projects DROP COLUMN IF EXISTS current_stage`);
  },
};

export default migration;
