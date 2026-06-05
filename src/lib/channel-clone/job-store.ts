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
import type { ChannelCloneJobState, ChannelCloneJobStatus, ProgressLogEntry } from './types';

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

/** Mark a job for cancellation. Atomic in SQL: sets
 *  `state_jsonb.cancelRequested = true` AND, when the current status
 *  is one of the `*_running` / `intake_pending` states, transitions
 *  the row's `status` column to `'cancelled'` so the UI's status pill
 *  flips immediately. The runner's between-step poll observes the
 *  cancelRequested flag and bails into its finally block (which stops
 *  the sandbox / refunds CPU). Returns true on a hit, false when the
 *  job doesn't exist in this workspace OR was already terminal. */
export async function requestChannelCloneJobCancel(
  jobId: string,
  workspaceId: string,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    UPDATE channel_clone_jobs
       SET state_jsonb = jsonb_set(state_jsonb, '{cancelRequested}', 'true'::jsonb),
           status = 'cancelled',
           updated_at = now()
     WHERE id = $1::uuid
       AND workspace_id = $2::uuid
       AND status IN (
         'intake_pending', 'intake_running',
         'analyze_running', 'topics_running', 'hooks_running',
         'script_running', 'rowify_running',
         'publish_pack_running', 'handoff_running'
       )
    `,
    [jobId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Variant of `setChannelCloneJobStatus` that refuses to update when
 *  `state_jsonb.cancelRequested === true`. The runner uses this for
 *  its final "stage complete" write so a cancellation that landed
 *  during the closing milliseconds of work doesn't get clobbered by
 *  a successful-status write. Returns true iff the update went
 *  through (i.e. the row existed AND was not cancelled). */
export async function setChannelCloneJobStatusUnlessCancelled(
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
       AND COALESCE((state_jsonb->>'cancelRequested')::boolean, false) = false
    `,
    [status, opts.lastError ?? null, jobId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Tight read of `state_jsonb.cancelRequested` for the runner to
 *  poll between steps. Returns false on a missing row OR missing
 *  field (the default — most jobs never get cancelled). */
export async function isChannelCloneJobCancelled(
  jobId: string,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await sql.query<{ cancelled: boolean }>(
    `
    SELECT COALESCE((state_jsonb->>'cancelRequested')::boolean, false) AS cancelled
      FROM channel_clone_jobs
     WHERE id = $1::uuid AND workspace_id = $2::uuid
     LIMIT 1
    `,
    [jobId, workspaceId],
  );
  return rows[0]?.cancelled === true;
}

/** Append one progress-log entry to `state_jsonb.progressLog`.
 *  Atomic at the SQL level: reads the current array, concats the
 *  new entry, writes back — so concurrent appenders won't lose
 *  entries (only one runner ever writes a given job, but this also
 *  works under retries / hot-reloads in dev). The append is
 *  intentionally fire-and-forget at the caller layer so a slow
 *  database write never blocks pipeline progress. */
export async function appendChannelCloneJobLog(
  jobId: string,
  workspaceId: string,
  entry: ProgressLogEntry,
): Promise<void> {
  await sql.query(
    `
    UPDATE channel_clone_jobs
       SET state_jsonb = jsonb_set(
             state_jsonb,
             '{progressLog}',
             COALESCE(state_jsonb->'progressLog', '[]'::jsonb) || $1::jsonb
           ),
           updated_at = now()
     WHERE id = $2::uuid AND workspace_id = $3::uuid
    `,
    [JSON.stringify([entry]), jobId, workspaceId],
  );
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
