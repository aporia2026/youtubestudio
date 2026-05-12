import type { Migration } from './types';

/**
 * Auto-pipeline tables — one-click batch creation from idea → script →
 * QA → narration wait → production doc.
 *
 * See `_plans/2026-05-12-auto-pipeline.md` for the design. Four tables:
 *
 *   pipeline_presets         — workspace-scoped config template (rules,
 *                              contexts, model fallback chains, gate
 *                              toggles, score thresholds). Reusable
 *                              across batches.
 *
 *   pipeline_runs            — one row per batch. Holds the user's
 *                              ranking decision, the cost estimate /
 *                              actual, and the batch-level lifecycle
 *                              (idea_ranking → running → done/cancelled).
 *
 *   pipeline_run_videos      — one row per video within a batch. This
 *                              is the unit the cron orchestrator drains.
 *                              Carries the per-video state machine
 *                              (stage), retry count, failure class,
 *                              narration deadline, and the FK chain that
 *                              links idea → script → critic panel →
 *                              narrator assignment → production doc.
 *
 *   pipeline_stage_artefacts — idempotency table. Cron retries are
 *                              guaranteed by Vercel's at-least-once
 *                              delivery; this table's composite PK
 *                              (video_id, stage, attempt_number,
 *                              artefact_kind) blocks duplicate writes
 *                              + double-charges when a tick re-enters
 *                              a stage that already produced an
 *                              artefact.
 *
 * Tenancy: every table carries workspace_id NOT NULL with ON DELETE
 * CASCADE on workspaces (match the post-migration-0013 pattern). The
 * pipeline_run_videos.workspace_id is denormalised from pipeline_runs
 * so the orchestrator's hot-path "claim the next pending row" query
 * filters by (workspace_id, stage) without a join.
 *
 * State machine (lives in pipeline_run_videos.stage as TEXT):
 *   queued → generating_idea → generating_script
 *     → (awaiting_script_gate when preset.script_gate_enabled)
 *     → running_qa → [qa_retry → running_qa]* → waiting_narration
 *     → [narration_overdue]? → narration_complete → generating_production_doc
 *     → done
 *
 * Terminal failure states (also TEXT on stage):
 *   qa_failed_after_max_retries, narration_abandoned,
 *   production_doc_failed, cancelled_by_user, cost_cap_exceeded
 *
 * TEXT (not ENUM) for stage so we can add new states in code without a
 * schema migration. A CHECK constraint would be nice but Postgres
 * doesn't make those easy to evolve either — application-level
 * validation in the orchestrator covers it.
 *
 * Workspace deletion CASCADES through everything. Preset deletion does
 * NOT cascade to runs (a deleted preset shouldn't wipe historical runs
 * that referenced it) — uses ON DELETE RESTRICT instead so the user is
 * forced to acknowledge there are runs referencing it.
 */
const migration: Migration = {
  id: '0052_create_pipeline_tables',
  description: 'Auto-pipeline: pipeline_presets / pipeline_runs / pipeline_run_videos / pipeline_stage_artefacts tables for one-click batch creation',

  async up(client) {
    // ─── pipeline_presets ──────────────────────────────────────────────
    //
    // Named, reusable configuration for a batch. `fallback_chains_jsonb`
    // is a record keyed by AppFeature id with an ordered array of model
    // ids — { "script-generator": ["claude-sonnet-4-6", "gpt-5.5", ...] }.
    // Validated in application code, not in the DB, because the model
    // catalogue lives in TypeScript and the DB doesn't know it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_presets (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        niche                       TEXT,
        ideas_count_default         INT NOT NULL DEFAULT 5 CHECK (ideas_count_default BETWEEN 1 AND 50),
        idea_context_jsonb          JSONB,
        script_rules_jsonb          JSONB,
        target_spoken_words         INT CHECK (target_spoken_words IS NULL OR target_spoken_words BETWEEN 50 AND 50000),
        qa_min_score                NUMERIC NOT NULL DEFAULT 75 CHECK (qa_min_score BETWEEN 0 AND 100),
        qa_max_iterations           INT NOT NULL DEFAULT 3 CHECK (qa_max_iterations BETWEEN 0 AND 10),
        script_gate_enabled         BOOLEAN NOT NULL DEFAULT true,
        production_doc_style_id     UUID REFERENCES production_doc_styles(id) ON DELETE SET NULL,
        narration_deadline_days     INT NOT NULL DEFAULT 7 CHECK (narration_deadline_days BETWEEN 1 AND 90),
        fallback_chains_jsonb       JSONB,
        created_by                  UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workspace_id, name)
      )
    `);

    // Most lookups list a workspace's presets newest first.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_presets_workspace
        ON pipeline_presets (workspace_id, updated_at DESC)
    `);

    // ─── pipeline_runs ─────────────────────────────────────────────────
    //
    // One row per batch. preset_id is RESTRICT'd (see header comment).
    // channel_id is nullable because the user may run a pipeline that
    // isn't tied to a specific channel yet.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        preset_id                   UUID NOT NULL REFERENCES pipeline_presets(id) ON DELETE RESTRICT,
        channel_id                  UUID REFERENCES channels(id) ON DELETE SET NULL,
        ideas_count                 INT NOT NULL CHECK (ideas_count BETWEEN 1 AND 50),
        status                      TEXT NOT NULL DEFAULT 'idea_ranking',
        estimated_cost_usd          NUMERIC,
        actual_cost_usd             NUMERIC NOT NULL DEFAULT 0,
        created_by                  UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at                TIMESTAMPTZ
      )
    `);

    // Dashboard hot-path: a workspace's recent batches.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_time
        ON pipeline_runs (workspace_id, created_at DESC)
    `);

    // ─── pipeline_run_videos ───────────────────────────────────────────
    //
    // The unit the cron orchestrator drains. workspace_id is
    // denormalised here (not just on the parent pipeline_runs row) so
    // the claim query — "give me the next pending video for any
    // workspace" — doesn't need to join to pipeline_runs.
    //
    // narration_deadline_at is set when stage transitions into
    // waiting_narration; nullable otherwise.
    //
    // claimed_at / claimed_by_tick are debug breadcrumbs for the
    // SELECT FOR UPDATE SKIP LOCKED pattern — they let us spot a
    // tick that crashed mid-stage by looking for old claimed_at
    // values on non-terminal rows.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_run_videos (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        pipeline_run_id             UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        priority                    INT NOT NULL CHECK (priority >= 1),
        stage                       TEXT NOT NULL DEFAULT 'queued',
        retry_count                 INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        failure_class               TEXT,
        failure_message             TEXT,
        cost_usd                    NUMERIC NOT NULL DEFAULT 0,
        idea_id                     UUID REFERENCES video_ideas(id) ON DELETE SET NULL,
        project_id                  UUID REFERENCES projects(id) ON DELETE SET NULL,
        script_id                   UUID REFERENCES scripts(id) ON DELETE SET NULL,
        critic_panel_id             UUID REFERENCES critic_panels(id) ON DELETE SET NULL,
        narrator_assignment_id      UUID REFERENCES narrator_assignments(id) ON DELETE SET NULL,
        production_doc_entry_id     UUID,
        narration_deadline_at       TIMESTAMPTZ,
        claimed_at                  TIMESTAMPTZ,
        claimed_by_tick             TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (pipeline_run_id, priority)
      )
    `);

    // Cron hot-path: claim the next pending video across all
    // workspaces, ordered by run creation time then priority. Filter
    // out terminal states via WHERE clause in the query (TEXT stage
    // means we can't put it in the index, but the partial-index
    // alternative would force a rebuild every time we add a state).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_run_videos_claim
        ON pipeline_run_videos (stage, pipeline_run_id, priority)
    `);

    // Per-batch listing on /pipeline/[id].
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_run_videos_run
        ON pipeline_run_videos (pipeline_run_id, priority)
    `);

    // Narration-overdue sweep — scoped to videos currently waiting.
    // Partial index keeps it small and only triggers on the rows the
    // sweep cares about.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_run_videos_narration_deadline
        ON pipeline_run_videos (narration_deadline_at)
        WHERE stage = 'waiting_narration' AND narration_deadline_at IS NOT NULL
    `);

    // ─── pipeline_stage_artefacts ──────────────────────────────────────
    //
    // Composite PK gives idempotency. attempt_number increments on
    // qa_retry / regenerate so each attempt's artefact is preserved.
    // artefact_id is a soft FK — the row it points at lives in
    // scripts / critic_panels / video_ideas / etc. depending on
    // artefact_kind. cost_usd is per-artefact so cancelled/superseded
    // attempts still show up on the batch-level cost rollup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_stage_artefacts (
        pipeline_run_video_id       UUID NOT NULL REFERENCES pipeline_run_videos(id) ON DELETE CASCADE,
        stage                       TEXT NOT NULL,
        attempt_number              INT NOT NULL CHECK (attempt_number >= 1),
        artefact_kind               TEXT NOT NULL,
        artefact_id                 UUID,
        cost_usd                    NUMERIC NOT NULL DEFAULT 0,
        metadata_jsonb              JSONB,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (pipeline_run_video_id, stage, attempt_number, artefact_kind)
      )
    `);

    // Used by the per-video detail UI to show "all artefacts produced
    // for this video, newest first" — including superseded attempts.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_stage_artefacts_video_time
        ON pipeline_stage_artefacts (pipeline_run_video_id, created_at DESC)
    `);
  },

  async down(client) {
    // Reverse order of `up`: children first, parent last.
    await client.query(`DROP TABLE IF EXISTS pipeline_stage_artefacts`);
    await client.query(`DROP TABLE IF EXISTS pipeline_run_videos`);
    await client.query(`DROP TABLE IF EXISTS pipeline_runs`);
    await client.query(`DROP TABLE IF EXISTS pipeline_presets`);
  },
};

export default migration;
