/**
 * Channel-clone job store — typed CRUD over `channel_clone_jobs`.
 *
 * Every read is workspace-scoped (the table has no global-listing
 * use case; admin debug can drop down to raw SQL). State updates
 * use `jsonb_set` / full-blob replacement depending on whether the
 * caller wants merge vs. overwrite — callers pick by which helper
 * they invoke.
 *
 * Schema lives in migration 0119_create_channel_clone_jobs. Shape
 * of `state_jsonb` is `ChannelCloneJobState` in `./types`.
 */

import { sql } from '@/lib/db';
import type { ChannelCloneJobState, ChannelCloneJobStatus } from './types';

/** Row shape as returned by SELECT *. */
export interface ChannelCloneJobRow {
  id: string;
  workspace_id: string;
  user_id: string;
  source_channel_url: string;
  source_canonical_url: string;
  status: ChannelCloneJobStatus;
  state_jsonb: ChannelCloneJobState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateChannelCloneJobInput {
  workspaceId: string;
  userId: string;
  sourceChannelUrl: string;
  sourceCanonicalUrl: string;
}

/** Insert a fresh job row. Returns the new id. */
export async function createChannelCloneJob(input: CreateChannelCloneJobInput): Promise<string> {
  const { rows } = await sql.query<{ id: string }>(
    `
    INSERT INTO channel_clone_jobs (
      workspace_id, user_id, source_channel_url, source_canonical_url, status
    ) VALUES ($1::uuid, $2::uuid, $3, $4, 'intake_pending')
    RETURNING id::text
    `,
    [input.workspaceId, input.userId, input.sourceChannelUrl, input.sourceCanonicalUrl],
  );
  return rows[0].id;
}

/** Load a job by id, scoped to the workspace. Returns null when no
 *  row matches (either missing id or cross-workspace access). */
export async function getChannelCloneJob(
  jobId: string,
  workspaceId: string,
): Promise<ChannelCloneJobRow | null> {
  const { rows } = await sql.query<ChannelCloneJobRow>(
    `
    SELECT id::text, workspace_id::text, user_id::text,
           source_channel_url, source_canonical_url, status,
           state_jsonb, last_error,
           created_at::text, updated_at::text
      FROM channel_clone_jobs
     WHERE id = $1::uuid AND workspace_id = $2::uuid
     LIMIT 1
    `,
    [jobId, workspaceId],
  );
  return rows[0] ?? null;
}

/** List jobs for the workspace, most-recently-updated first. */
export async function listChannelCloneJobs(
  workspaceId: string,
  limit = 50,
): Promise<ChannelCloneJobRow[]> {
  const { rows } = await sql.query<ChannelCloneJobRow>(
    `
    SELECT id::text, workspace_id::text, user_id::text,
           source_channel_url, source_canonical_url, status,
           state_jsonb, last_error,
           created_at::text, updated_at::text
      FROM channel_clone_jobs
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
     LIMIT $2::int
    `,
    [workspaceId, limit],
  );
  return rows;
}

/** Atomically advance a job's status and optionally clear/set the
 *  last_error column. Returns true on a hit, false if the workspace
 *  guard rejected the update. */
export async function setChannelCloneJobStatus(
  jobId: string,
  workspaceId: string,
  status: ChannelCloneJobStatus,
  opts: { lastError?: string | null } = {},
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    UPDATE channel_clone_jobs
       SET status = $1,
           last_error = $2,
           updated_at = now()
     WHERE id = $3::uuid AND workspace_id = $4::uuid
    `,
    [status, opts.lastError ?? null, jobId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Merge a partial state patch into `state_jsonb`. Uses Postgres's
 *  `||` operator (jsonb concatenate / shallow merge) — top-level
 *  keys in the patch replace top-level keys in the row, but deeper
 *  nested fields are not deep-merged. Callers that need deep merge
 *  should read → mutate in TS → call `replaceChannelCloneJobState`. */
export async function mergeChannelCloneJobState(
  jobId: string,
  workspaceId: string,
  patch: Partial<ChannelCloneJobState>,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    UPDATE channel_clone_jobs
       SET state_jsonb = state_jsonb || $1::jsonb,
           updated_at = now()
     WHERE id = $2::uuid AND workspace_id = $3::uuid
    `,
    [JSON.stringify(patch), jobId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Overwrite `state_jsonb` with the supplied object. Use when the
 *  caller already loaded → mutated → wants to persist the whole
 *  blob (the safe-rather-than-clever path). */
export async function replaceChannelCloneJobState(
  jobId: string,
  workspaceId: string,
  state: ChannelCloneJobState,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    UPDATE channel_clone_jobs
       SET state_jsonb = $1::jsonb,
           updated_at = now()
     WHERE id = $2::uuid AND workspace_id = $3::uuid
    `,
    [JSON.stringify(state), jobId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
