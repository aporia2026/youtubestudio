/**
 * Persistence layer for the live Court of Critics.
 *
 * The runner in `script-critics/runner-live.ts` is pure (yields events,
 * touches no DB). This file is what the route handler uses to:
 *   - Create the parent `critic_panels` row at run start
 *   - Append each emitted event to `critic_panel_events` with a monotonic
 *     sequence number
 *   - Stamp the final verdict (or error) onto the parent row at end
 *   - Read panel + events back for replay / detail views
 *
 * Sequence numbers are assigned client-side (a counter held by the route
 * handler) rather than via a database SERIAL. We can do this safely because
 * a single panel run has a single writer — the SSE handler that owns the
 * AsyncGenerator. If we ever need multiple writers per panel (e.g. a
 * background re-runner), switch to a DB-side sequence.
 */
import { sql } from '@vercel/postgres';
import type {
  CriticPanelEventRow,
  CriticPanelRow,
  PanelEvent,
} from './script-critics/panel-events';
import type { ScriptCharter, ScriptPanelVerdict } from './script-critics/types';

export interface CreateCriticPanelArgs {
  workspaceId: string;
  projectId: string | null;
  sourceScriptId: string | null;
  scriptText: string;
  niche: string;
  passNumber: number;
  aggressiveness: 'standard' | 'brutal' | 'nuclear';
  modelId: string;
}

export async function createCriticPanel(args: CreateCriticPanelArgs): Promise<{ id: string }> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO critic_panels (
      workspace_id, project_id, source_script_id,
      script_text, niche, pass_number, aggressiveness, model_id,
      status
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      ${args.sourceScriptId}::uuid,
      ${args.scriptText},
      ${args.niche},
      ${args.passNumber},
      ${args.aggressiveness},
      ${args.modelId},
      'running'
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function appendCriticPanelEvent(args: {
  workspaceId: string;
  panelId: string;
  sequenceNo: number;
  event: Omit<PanelEvent, 'sequence_no' | 'captured_at'>;
}): Promise<void> {
  // sql template can't bind JSONB directly from an object — stringify first.
  const payloadJson = JSON.stringify(args.event.payload ?? {});
  await sql`
    INSERT INTO critic_panel_events (
      workspace_id, panel_id, sequence_no, phase, critic_id, event_type, payload
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.panelId}::uuid,
      ${args.sequenceNo},
      ${args.event.phase},
      ${args.event.critic_id},
      ${args.event.event_type},
      ${payloadJson}::jsonb
    )
  `;
  await sql`
    UPDATE critic_panels
       SET updated_at = NOW()
     WHERE id = ${args.panelId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
}

export async function completeCriticPanel(args: {
  workspaceId: string;
  panelId: string;
  verdict: ScriptPanelVerdict;
  charter: ScriptCharter | null;
}): Promise<void> {
  const verdictJson = JSON.stringify(args.verdict);
  const charterJson = args.charter ? JSON.stringify(args.charter) : null;
  await sql`
    UPDATE critic_panels
       SET status = 'completed',
           verdict = ${verdictJson}::jsonb,
           charter = ${charterJson}::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
     WHERE id = ${args.panelId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
}

export async function failCriticPanel(args: {
  workspaceId: string;
  panelId: string;
  errorMessage: string;
}): Promise<void> {
  await sql`
    UPDATE critic_panels
       SET status = 'failed',
           error_message = ${args.errorMessage.slice(0, 1000)},
           completed_at = NOW(),
           updated_at = NOW()
     WHERE id = ${args.panelId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
}

// ─── Reads ─────────────────────────────────────────────────────────────

export async function getCriticPanel(
  id: string,
  workspaceId: string,
): Promise<CriticPanelRow | null> {
  const { rows } = await sql<CriticPanelRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      script_text, niche, pass_number, aggressiveness, model_id,
      status, error_message, verdict, charter,
      started_at::text AS started_at,
      completed_at::text AS completed_at,
      updated_at::text AS updated_at
    FROM critic_panels
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listCriticPanels(
  workspaceId: string,
  opts: { projectId?: string; scriptId?: string; limit?: number } = {},
): Promise<CriticPanelRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.scriptId) {
    const { rows } = await sql<CriticPanelRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        script_text, niche, pass_number, aggressiveness, model_id,
        status, error_message, verdict, charter,
        started_at::text AS started_at,
        completed_at::text AS completed_at,
        updated_at::text AS updated_at
      FROM critic_panels
      WHERE workspace_id = ${workspaceId}::uuid
        AND source_script_id = ${opts.scriptId}::uuid
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.projectId) {
    const { rows } = await sql<CriticPanelRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        script_text, niche, pass_number, aggressiveness, model_id,
        status, error_message, verdict, charter,
        started_at::text AS started_at,
        completed_at::text AS completed_at,
        updated_at::text AS updated_at
      FROM critic_panels
      WHERE workspace_id = ${workspaceId}::uuid
        AND project_id = ${opts.projectId}::uuid
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<CriticPanelRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      script_text, niche, pass_number, aggressiveness, model_id,
      status, error_message, verdict, charter,
      started_at::text AS started_at,
      completed_at::text AS completed_at,
      updated_at::text AS updated_at
    FROM critic_panels
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function listCriticPanelEvents(
  panelId: string,
  workspaceId: string,
  opts: { sinceSequence?: number } = {},
): Promise<CriticPanelEventRow[]> {
  const since = Math.max(0, opts.sinceSequence ?? 0);
  const { rows } = await sql<CriticPanelEventRow>`
    SELECT
      id, workspace_id, panel_id, sequence_no, phase, critic_id,
      event_type, payload,
      captured_at::text AS captured_at
    FROM critic_panel_events
    WHERE panel_id = ${panelId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND sequence_no > ${since}
    ORDER BY sequence_no ASC
  `;
  return rows;
}

export async function deleteCriticPanel(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM critic_panels
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}
