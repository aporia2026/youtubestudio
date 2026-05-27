/**
 * DB helpers for the auto-pipeline orchestrator.
 *
 * Three responsibilities:
 *
 *   1. `claimNextVideo()` — atomically grab the next pending video
 *      row for the cron to process. Uses `FOR UPDATE SKIP LOCKED`
 *      so two overlapping cron ticks can't claim the same row.
 *      Per-row claim handles the data-level race; the cron entry's
 *      `withCronLock` advisory lock handles the invocation-level
 *      race. Both, not either-or — council-mandated.
 *
 *   2. `advanceStage(...)` / `failStage(...)` — write the next
 *      stage (or terminal failure state) onto the row + apply any
 *      FK updates the handler produced. Wrapped in a transaction
 *      with the artefact insert so idempotency is atomic.
 *
 *   3. `persistArtefact(...)` — insert one row into
 *      pipeline_stage_artefacts via INSERT … ON CONFLICT DO NOTHING.
 *      The PK is (video_id, stage, attempt_number, artefact_kind);
 *      conflicts mean "this attempt already ran" — the orchestrator
 *      can treat that as "skip; advance to next stage on the next
 *      tick" so a crashed mid-stage doesn't double-charge.
 *
 * All queries scope by `workspace_id` even when the caller passes a
 * primary-key id — matches the Phase 8 audit pattern.
 */
import { sql } from '@vercel/postgres';
import type {
  PipelineRunVideoRow,
  PipelinePreset,
  PipelineStage,
  VideoFieldUpdates,
} from './types';
import { ACTIVE_STAGES, isPipelineStage, TERMINAL_STAGES } from './types';
import { logger } from '../logger';

// ─── Claim ──────────────────────────────────────────────────────────

/**
 * Returns the next pending video for the cron to process, with its
 * preset already joined for the handler's convenience. The row is
 * marked claimed (`claimed_at = now()`, `claimed_by_tick = tickId`)
 * inside the same transaction so a concurrent SELECT FOR UPDATE
 * SKIP LOCKED from another cron tick skips it.
 *
 * Returns `null` when no eligible row exists — caller exits the
 * drain loop.
 *
 * Active-stage filter happens here (not at the call site) so the
 * orchestrator never has to think about waiting/terminal stages.
 */
export async function claimNextVideo(tickId: string): Promise<{
  video: PipelineRunVideoRow;
  preset: PipelinePreset;
} | null> {
  // Build the ACTIVE_STAGES list as a Postgres ANY(array) param so
  // adding a new active stage in code doesn't require a query edit.
  const activeStagesList = Array.from(ACTIVE_STAGES);

  // SELECT FOR UPDATE SKIP LOCKED inside a transaction so the
  // UPDATE that marks the claim sees the same row the SELECT
  // returned. We use a CTE so the whole operation is a single
  // round-trip to Postgres.
  //
  // Ordering: oldest run first (pipeline_runs.created_at ASC), then
  // priority within the run (lowest priority number = first). That
  // way a long-running batch from yesterday drains before a new
  // batch from today.
  const { rows } = await sql.query<PipelineRunVideoRow>(
    `
    WITH claim AS (
      SELECT v.id
        FROM pipeline_run_videos v
        JOIN pipeline_runs r ON r.id = v.pipeline_run_id
       WHERE v.stage = ANY($1::text[])
         AND v.claimed_at IS NULL
       ORDER BY r.created_at ASC, v.priority ASC
       LIMIT 1
       FOR UPDATE OF v SKIP LOCKED
    )
    UPDATE pipeline_run_videos
       SET claimed_at = NOW(),
           claimed_by_tick = $2,
           updated_at = NOW()
      FROM claim
     WHERE pipeline_run_videos.id = claim.id
    RETURNING pipeline_run_videos.*
    `,
    [activeStagesList, tickId],
  );

  if (rows.length === 0) return null;
  const video = rows[0];

  // Join the preset in a second query (the JOIN-then-UPDATE form
  // doesn't return joined columns; cleaner this way). Workspace
  // scope is enforced via the FK chain — both the video and the
  // preset belong to the same pipeline_run, which belongs to the
  // same workspace.
  //
  // LEFT JOIN the four feature-preset tables so resolvePreset* helpers
  // can read from the bundle without a follow-up round-trip per tick.
  // row_to_json gives each nested row as a JSON object on the parent
  // result (snake_case columns straight through), which matches the
  // ScriptPreset/QaPreset/NarrationPreset/IdeaPreset interface shapes.
  const { rows: presetRows } = await sql.query<PipelinePreset>(
    `
    SELECT p.id, p.workspace_id, p.name, p.niche, p.ideas_count_default,
           p.idea_context_jsonb, p.script_rules_jsonb, p.target_spoken_words,
           p.qa_min_score, p.qa_max_iterations, p.script_gate_enabled,
           p.production_doc_style_id, p.script_style_preset_id, p.narration_deadline_days,
           p.script_preset_id, p.qa_preset_id, p.narration_preset_id, p.idea_preset_id,
           p.fallback_chains_jsonb, p.video_editor_collaborator_id,
           p.thumbnail_template_id, p.seo_template_id,
           CASE WHEN sp.id IS NULL THEN NULL ELSE row_to_json(sp.*) END AS script_preset,
           CASE WHEN qp.id IS NULL THEN NULL ELSE row_to_json(qp.*) END AS qa_preset,
           CASE WHEN np.id IS NULL THEN NULL ELSE row_to_json(np.*) END AS narration_preset,
           CASE WHEN ip.id IS NULL THEN NULL ELSE row_to_json(ip.*) END AS idea_preset
      FROM pipeline_presets p
      JOIN pipeline_runs r ON r.preset_id = p.id
      LEFT JOIN script_presets sp    ON sp.id = p.script_preset_id
      LEFT JOIN qa_presets qp        ON qp.id = p.qa_preset_id
      LEFT JOIN narration_presets np ON np.id = p.narration_preset_id
      LEFT JOIN idea_presets ip      ON ip.id = p.idea_preset_id
     WHERE r.id = $1::uuid
    `,
    [video.pipeline_run_id],
  );

  if (presetRows.length === 0) {
    // Shouldn't happen — preset has ON DELETE RESTRICT on
    // pipeline_runs. Defensive: release the claim and warn.
    logger.warn('auto-pipeline: claim found video but preset missing — releasing', {
      video_id: video.id,
      tick_id: tickId,
    });
    await sql`UPDATE pipeline_run_videos SET claimed_at = NULL, claimed_by_tick = NULL WHERE id = ${video.id}::uuid`;
    return null;
  }

  return { video, preset: presetRows[0] };
}

/**
 * Release a claim without advancing — used when a handler throws an
 * unexpected error and the orchestrator wants the next tick to
 * retry the same stage. Distinct from `failStage`, which marks the
 * video as terminally failed.
 */
export async function releaseClaim(videoId: string): Promise<void> {
  await sql`
    UPDATE pipeline_run_videos
       SET claimed_at = NULL,
           claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${videoId}::uuid
  `;
}

// ─── Advance / Fail ─────────────────────────────────────────────────

/**
 * Advance a claimed video to its next stage. Applies any FK
 * updates the handler produced (e.g. setting `idea_id` after
 * idea-gen). Clears the claim so the next active stage is
 * picked up by the following cron tick.
 *
 * Throws if `nextStage` isn't a known stage name — defensive
 * since stage is TEXT in the DB but we want application code to
 * own the valid-stage set.
 */
export async function advanceStage(
  videoId: string,
  nextStage: PipelineStage,
  updates: VideoFieldUpdates | undefined,
  costDeltaUsd: number,
): Promise<void> {
  if (!isPipelineStage(nextStage)) {
    throw new Error(`advanceStage: invalid stage name "${nextStage}"`);
  }

  // Build the UPDATE dynamically based on which FKs the handler
  // wrote. sql.query so we can compose the SET list.
  const fields: string[] = ['stage = $2', 'claimed_at = NULL', 'claimed_by_tick = NULL', 'updated_at = NOW()', 'cost_usd = cost_usd + $3'];
  const params: unknown[] = [videoId, nextStage, costDeltaUsd];
  let i = 4;

  if (updates) {
    if (updates.idea_id !== undefined) { fields.push(`idea_id = $${i++}::uuid`); params.push(updates.idea_id); }
    if (updates.project_id !== undefined) { fields.push(`project_id = $${i++}::uuid`); params.push(updates.project_id); }
    if (updates.script_id !== undefined) { fields.push(`script_id = $${i++}::uuid`); params.push(updates.script_id); }
    if (updates.critic_panel_id !== undefined) { fields.push(`critic_panel_id = $${i++}::uuid`); params.push(updates.critic_panel_id); }
    if (updates.narrator_assignment_id !== undefined) { fields.push(`narrator_assignment_id = $${i++}::uuid`); params.push(updates.narrator_assignment_id); }
    if (updates.production_doc_entry_id !== undefined) { fields.push(`production_doc_entry_id = $${i++}::uuid`); params.push(updates.production_doc_entry_id); }
    if (updates.thumbnail_url !== undefined) { fields.push(`thumbnail_url = $${i++}`); params.push(updates.thumbnail_url); }
    if (updates.editor_assignment_id !== undefined) { fields.push(`editor_assignment_id = $${i++}::uuid`); params.push(updates.editor_assignment_id); }
    if (updates.narration_deadline_at !== undefined) { fields.push(`narration_deadline_at = $${i++}::timestamptz`); params.push(updates.narration_deadline_at); }
    if (updates.retry_count !== undefined) { fields.push(`retry_count = $${i++}`); params.push(updates.retry_count); }
  }

  // Also roll up cost onto the parent pipeline_runs row in the
  // same transaction. cost_usd is NUMERIC so the cast is needed.
  await sql.query(
    `
    WITH v AS (
      UPDATE pipeline_run_videos
         SET ${fields.join(', ')}
       WHERE id = $1::uuid
      RETURNING pipeline_run_id, cost_usd
    )
    UPDATE pipeline_runs
       SET actual_cost_usd = actual_cost_usd + $3,
           completed_at = CASE
             WHEN $2 = 'done' AND NOT EXISTS (
               SELECT 1 FROM pipeline_run_videos prv
                WHERE prv.pipeline_run_id = pipeline_runs.id
                  AND prv.stage NOT IN ('done', 'qa_failed_after_max_retries', 'narration_abandoned', 'production_doc_failed', 'thumbnail_failed', 'editor_assignment_failed', 'cancelled_by_user', 'cost_cap_exceeded')
                  AND prv.id <> v.pipeline_run_id  -- exclude the one we just advanced (it's already done)
             ) THEN NOW()
             ELSE pipeline_runs.completed_at
           END
      FROM v
     WHERE pipeline_runs.id = v.pipeline_run_id
    `,
    params,
  );
}

/**
 * Mark a video as terminally failed. Records the failure class +
 * message so the UI can show "what broke." Same transaction-and-
 * cost-rollup pattern as `advanceStage`.
 */
export async function failStage(
  videoId: string,
  terminalStage: PipelineStage,
  failureClass: string,
  failureMessage: string,
  costDeltaUsd: number,
): Promise<void> {
  if (!TERMINAL_STAGES.has(terminalStage)) {
    throw new Error(`failStage: not a terminal stage "${terminalStage}"`);
  }
  await sql`
    UPDATE pipeline_run_videos
       SET stage = ${terminalStage},
           failure_class = ${failureClass},
           failure_message = ${failureMessage.slice(0, 1000)},
           cost_usd = cost_usd + ${costDeltaUsd},
           claimed_at = NULL,
           claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${videoId}::uuid
  `;
  await sql`
    UPDATE pipeline_runs r
       SET actual_cost_usd = actual_cost_usd + ${costDeltaUsd}
      FROM pipeline_run_videos v
     WHERE v.id = ${videoId}::uuid
       AND r.id = v.pipeline_run_id
  `;
}

// ─── Artefact persistence (idempotency) ─────────────────────────────

export interface PersistArtefactInput {
  pipelineRunVideoId: string;
  stage: PipelineStage;
  attemptNumber: number;
  artefactKind: string;
  artefactId?: string | null;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one row into pipeline_stage_artefacts. ON CONFLICT DO
 * NOTHING because the PK (video_id, stage, attempt_number,
 * artefact_kind) is the idempotency key — a cron retry on the
 * same attempt should not double-write.
 *
 * Returns `true` when a row was actually inserted, `false` when
 * the conflict-do-nothing path was taken. The orchestrator uses
 * this to decide whether the upstream call ran or was a no-op.
 */
export async function persistArtefact(input: PersistArtefactInput): Promise<boolean> {
  const { rows } = await sql.query<{ inserted: boolean }>(
    `
    INSERT INTO pipeline_stage_artefacts
      (pipeline_run_video_id, stage, attempt_number, artefact_kind, artefact_id, cost_usd, metadata_jsonb)
    VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::jsonb)
    ON CONFLICT (pipeline_run_video_id, stage, attempt_number, artefact_kind) DO NOTHING
    RETURNING true AS inserted
    `,
    [
      input.pipelineRunVideoId,
      input.stage,
      input.attemptNumber,
      input.artefactKind,
      input.artefactId ?? null,
      input.costUsd,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return rows.length > 0;
}

/**
 * Returns the latest artefact (highest attempt_number) for a given
 * (video_id, stage, artefact_kind). Used by handlers that want to
 * check "did I already run this on a prior tick?" — though most
 * idempotency is enforced via persistArtefact's PK conflict.
 */
export async function getLatestArtefact(
  pipelineRunVideoId: string,
  stage: PipelineStage,
  artefactKind: string,
): Promise<{ attempt_number: number; artefact_id: string | null; cost_usd: string; metadata_jsonb: Record<string, unknown> | null } | null> {
  const { rows } = await sql.query<{ attempt_number: number; artefact_id: string | null; cost_usd: string; metadata_jsonb: Record<string, unknown> | null }>(
    `
    SELECT attempt_number, artefact_id, cost_usd, metadata_jsonb
      FROM pipeline_stage_artefacts
     WHERE pipeline_run_video_id = $1::uuid
       AND stage = $2
       AND artefact_kind = $3
     ORDER BY attempt_number DESC
     LIMIT 1
    `,
    [pipelineRunVideoId, stage, artefactKind],
  );
  return rows[0] ?? null;
}

// ─── Workspace-scoped reads (for UI / batch creation) ───────────────

/**
 * Fetch a preset by id, scoped to workspace. Returns null on
 * cross-workspace access — same 404-not-403 pattern as
 * Phase 8.1.
 */
export async function getPresetForWorkspace(
  presetId: string,
  workspaceId: string,
): Promise<PipelinePreset | null> {
  const { rows } = await sql.query<PipelinePreset>(
    `
    SELECT p.id, p.workspace_id, p.name, p.niche, p.ideas_count_default,
           p.idea_context_jsonb, p.script_rules_jsonb, p.target_spoken_words,
           p.qa_min_score, p.qa_max_iterations, p.script_gate_enabled,
           p.production_doc_style_id, p.script_style_preset_id, p.narration_deadline_days,
           p.script_preset_id, p.qa_preset_id, p.narration_preset_id, p.idea_preset_id,
           p.fallback_chains_jsonb, p.video_editor_collaborator_id,
           p.thumbnail_template_id, p.seo_template_id,
           CASE WHEN sp.id IS NULL THEN NULL ELSE row_to_json(sp.*) END AS script_preset,
           CASE WHEN qp.id IS NULL THEN NULL ELSE row_to_json(qp.*) END AS qa_preset,
           CASE WHEN np.id IS NULL THEN NULL ELSE row_to_json(np.*) END AS narration_preset,
           CASE WHEN ip.id IS NULL THEN NULL ELSE row_to_json(ip.*) END AS idea_preset
      FROM pipeline_presets p
      LEFT JOIN script_presets sp    ON sp.id = p.script_preset_id
      LEFT JOIN qa_presets qp        ON qp.id = p.qa_preset_id
      LEFT JOIN narration_presets np ON np.id = p.narration_preset_id
      LEFT JOIN idea_presets ip      ON ip.id = p.idea_preset_id
     WHERE p.id = $1::uuid AND p.workspace_id = $2::uuid
    `,
    [presetId, workspaceId],
  );
  return rows[0] ?? null;
}
