/**
 * Channel-clone template store — typed CRUD over `channel_clone_templates`.
 *
 * Schema lives in migration 0121_create_channel_clone_templates.
 * Two-phase delete: `softDeleteTemplate` flips `deleted_at` on the
 * SQL row and queues R2 cleanup; a separate sweep (24h TTL) calls
 * `hardDeleteTemplate` to drop the row once R2 has settled.
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { sql } from '@/lib/db';

/** Persisted shape of `config_jsonb` on the templates table. Mirrors
 *  the intake-upload route's body so the load flow can hand it
 *  straight back without re-mapping. The per-video `r2Key` fields
 *  point at the TEMPLATE-OWNED prefix (channel-clone-templates/...),
 *  not the original job's staging prefix. */
export interface ChannelCloneTemplateConfig {
  /** Optional source YouTube channel URL for the publish-pack stage
   *  to reason about niche / similar channels. May be `upload://manual`
   *  when the template was saved from a pure-upload run. */
  sourceChannelUrl?: string | null;
  sourceChannelHandle?: string | null;
  /** Best-effort source channel name — drives default labels on the
   *  load form + the clone-voice name pattern. */
  sourceChannelName: string | null;
  /** Per-settings frame interval (5/10/15s). */
  frameIntervalSec: 5 | 10 | 15;
  /** Per-video records — title, R2 key (template-owned), operator-
   *  pasted transcript text. */
  videos: {
    r2Key: string;
    title: string;
    transcript: string;
  }[];
  /** When set, the load flow's voice-profile/clone path pre-fills
   *  the voice_id and skips re-cloning on the new run. The operator
   *  can still press Clone in the new panel to create a fresh voice
   *  for that run. */
  clonedVoiceId?: string;
}

/** Row shape as returned by SELECT *. */
export interface ChannelCloneTemplateRow {
  id: string;
  workspace_id: string;
  created_by: string;
  name: string;
  config_jsonb: ChannelCloneTemplateConfig;
  r2_keys: string[];
  bytes: number;
  created_at: string;
  /** Null for live templates; ISO timestamp for soft-deleted ones. */
  deleted_at: string | null;
}

export interface CreateChannelCloneTemplateInput {
  workspaceId: string;
  userId: string;
  name: string;
  config: ChannelCloneTemplateConfig;
  r2Keys: string[];
  bytes: number;
}

/** Create a fresh template. Throws on name conflict (unique partial
 *  index). The route translates the error into a 409 + replace prompt. */
export async function createChannelCloneTemplate(
  input: CreateChannelCloneTemplateInput,
): Promise<{ templateId: string }> {
  const { rows } = await sql.query<{ id: string }>(
    `
    INSERT INTO channel_clone_templates (
      workspace_id, created_by, name, config_jsonb, r2_keys, bytes
    ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::text[], $6::bigint)
    RETURNING id::text
    `,
    [
      input.workspaceId,
      input.userId,
      input.name,
      JSON.stringify(input.config),
      input.r2Keys,
      input.bytes,
    ],
  );
  return { templateId: rows[0].id };
}

/** List live templates for the workspace, most-recently-created
 *  first. Powers the "Use template" dropdown + the management page. */
export async function listChannelCloneTemplates(
  workspaceId: string,
  limit = 100,
): Promise<ChannelCloneTemplateRow[]> {
  const { rows } = await sql.query<ChannelCloneTemplateRow>(
    `
    SELECT id::text, workspace_id::text, created_by::text,
           name, config_jsonb, r2_keys, bytes::bigint AS bytes,
           created_at::text, deleted_at::text
      FROM channel_clone_templates
     WHERE workspace_id = $1::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2::int
    `,
    [workspaceId, limit],
  );
  return rows;
}

/** Load a live template by id, scoped to the workspace. Soft-deleted
 *  rows return null. */
export async function getChannelCloneTemplate(
  templateId: string,
  workspaceId: string,
): Promise<ChannelCloneTemplateRow | null> {
  const { rows } = await sql.query<ChannelCloneTemplateRow>(
    `
    SELECT id::text, workspace_id::text, created_by::text,
           name, config_jsonb, r2_keys, bytes::bigint AS bytes,
           created_at::text, deleted_at::text
      FROM channel_clone_templates
     WHERE id = $1::uuid AND workspace_id = $2::uuid AND deleted_at IS NULL
     LIMIT 1
    `,
    [templateId, workspaceId],
  );
  return rows[0] ?? null;
}

/** Soft-delete: stamp `deleted_at`. R2 keys stay alive for the reap
 *  cron to clean. Returns true if the row existed and was newly
 *  flagged; false if it was already gone (idempotent). */
export async function softDeleteChannelCloneTemplate(
  templateId: string,
  workspaceId: string,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    UPDATE channel_clone_templates
       SET deleted_at = now()
     WHERE id = $1::uuid AND workspace_id = $2::uuid AND deleted_at IS NULL
    `,
    [templateId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Count live templates in a workspace. Used by the save endpoint to
 *  enforce the per-workspace cap. */
export async function countChannelCloneTemplates(workspaceId: string): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM channel_clone_templates
      WHERE workspace_id = $1::uuid AND deleted_at IS NULL`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? '0');
}

/** Fetch soft-deleted templates older than `maxAgeHours` so the
 *  cleanup sweep can run R2 batch-deletes + hard-delete the rows.
 *  Cross-workspace; the caller is expected to be an admin/cron path. */
export async function listChannelCloneTemplatesPendingReap(
  maxAgeHours: number,
): Promise<ChannelCloneTemplateRow[]> {
  const { rows } = await sql.query<ChannelCloneTemplateRow>(
    `
    SELECT id::text, workspace_id::text, created_by::text,
           name, config_jsonb, r2_keys, bytes::bigint AS bytes,
           created_at::text, deleted_at::text
      FROM channel_clone_templates
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - ($1::int * interval '1 hour')
     ORDER BY deleted_at ASC
     LIMIT 200
    `,
    [maxAgeHours],
  );
  return rows;
}

/** Hard-delete a row once its R2 manifest has been swept. The reaper
 *  calls this AFTER `deleteTemplateR2Keys` succeeds for the row's
 *  keys. */
export async function hardDeleteChannelCloneTemplate(templateId: string): Promise<void> {
  await sql.query(
    `DELETE FROM channel_clone_templates WHERE id = $1::uuid`,
    [templateId],
  );
}

/** Determine whether the caller's intended template name collides
 *  with an existing live row in the workspace. Used by the route to
 *  ask the operator about "replace this template?" before doing the
 *  destructive flow. Case-insensitive — mirrors the unique index. */
export async function findChannelCloneTemplateByName(
  workspaceId: string,
  name: string,
): Promise<ChannelCloneTemplateRow | null> {
  const { rows } = await sql.query<ChannelCloneTemplateRow>(
    `
    SELECT id::text, workspace_id::text, created_by::text,
           name, config_jsonb, r2_keys, bytes::bigint AS bytes,
           created_at::text, deleted_at::text
      FROM channel_clone_templates
     WHERE workspace_id = $1::uuid
       AND lower(name) = lower($2)
       AND deleted_at IS NULL
     LIMIT 1
    `,
    [workspaceId, name],
  );
  return rows[0] ?? null;
}
