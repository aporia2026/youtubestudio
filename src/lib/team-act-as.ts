/**
 * "Act as <collaborator>" helper used by the /team-hub surface.
 *
 * The owner can write a narrator/editor/reviewer comment, take resolution,
 * or version approval on the team member's behalf. Every escalated action
 * runs through `actAsCollaborator` so that:
 *
 *   1. The target collaborator is verified to belong to the actor's
 *      workspace (no cross-tenant act-as).
 *   2. An audit row is written to `team_hub_audit_log` whether the
 *      underlying action succeeds or fails — the user-decided rule is
 *      "always audit" so the trail captures intent, not just commits.
 *
 * The helper is small on purpose: it does NOT touch the comment / take /
 * version tables itself. Callers pass `fn` that performs the actual write
 * (typically a one-line wrapper over an existing db helper). This keeps
 * the audit logic in one place without coupling it to every comment shape.
 *
 * Tenancy gate: collaborators don't carry a `workspace_id` column directly
 * (they're a global identity table extended for auth in migration 0003).
 * Their workspace association is implicit via the assignment / share-link
 * tables. The gate query checks for at least one of:
 *   - narrator_assignments(narrator_id = target, workspace_id = actor.ws)
 *   - editor_assignments(editor_id = target, workspace_id = actor.ws)
 *   - review_share_links(collaborator_id = target, workspace_id = actor.ws)
 * If none match, the act-as call is refused before `fn` is called.
 */
import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

/** Surfaces the escalation can write into. Add new entries here when wiring
 *  a new "Act as" button into a previously-unsupported component. */
export const ACT_AS_SURFACES = [
  'narration_take_comment',
  'narrator_section_comment',
  'review_comment',
] as const;
export type ActAsSurface = (typeof ACT_AS_SURFACES)[number];

/** Stable machine keys for what was attempted. Append-only — renaming an
 *  existing key would break historical audit-log queries. */
export const ACT_AS_ACTIONS = [
  'post_comment',
  'reply_to_comment',
  'resolve_comment',
  'unresolve_comment',
  'mark_take_selected',
  'approve_section',
  'approve_version',
] as const;
export type ActAsAction = (typeof ACT_AS_ACTIONS)[number];

export interface ActAsContext {
  /** Collaborators.id of the authenticated owner (session.uid). */
  actorUserId: string;
  /** Owner's workspace (session.ws). The audit row is scoped to this id
   *  and the tenancy gate runs against this workspace. */
  workspaceId: string;
  /** Collaborator the owner is acting as. */
  targetCollaboratorId: string;
  /** What is being attempted — see ACT_AS_ACTIONS. */
  actionType: ActAsAction;
  /** Which embedded surface fired this — see ACT_AS_SURFACES. */
  surface: ActAsSurface;
  /** Optional id of the row being acted on (e.g. a take id, version id,
   *  comment id). Stored on the audit row for forensic linkage. */
  targetId?: string;
}

/** Thrown when the workspace-tenancy gate refuses the act-as attempt.
 *  The route layer maps this to a 404 so existence isn't leaked across
 *  tenants. */
export class ActAsTenancyError extends Error {
  constructor(public readonly targetCollaboratorId: string) {
    super(`Collaborator ${targetCollaboratorId} is not in this workspace.`);
    this.name = 'ActAsTenancyError';
  }
}

/**
 * Workspace tenancy gate. Returns true if the target collaborator has at
 * least one assignment or share-link in the workspace. False otherwise.
 *
 * Uses a single round-trip with a UNION ALL so we read at most one row
 * per assignment table — short-circuits as soon as any branch finds a
 * match thanks to the outer LIMIT 1.
 */
async function targetIsInWorkspace(
  targetCollaboratorId: string,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await sql<{ exists: number }>`
    SELECT 1 AS exists
      FROM (
        SELECT 1 FROM narrator_assignments
         WHERE narrator_id = ${targetCollaboratorId}
           AND workspace_id = ${workspaceId}
        UNION ALL
        SELECT 1 FROM editor_assignments
         WHERE editor_id = ${targetCollaboratorId}
           AND workspace_id = ${workspaceId}
        UNION ALL
        SELECT 1 FROM review_share_links
         WHERE collaborator_id = ${targetCollaboratorId}
           AND workspace_id = ${workspaceId}
      ) AS scoped
     LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Best-effort audit insert. Wrapped in its own try/catch so a DB failure
 * on the audit write does NOT mask the original outcome of `fn` — the
 * caller still sees the success / failure of the actual action. Logged
 * at error level so a broken audit pipeline shows up in the structured
 * log search.
 */
async function writeAuditRow(
  ctx: ActAsContext,
  result: 'success' | 'failure',
  errorMessage: string | null,
): Promise<void> {
  try {
    await sql`
      INSERT INTO team_hub_audit_log (
        workspace_id,
        actor_user_id,
        target_collaborator_id,
        action_type,
        surface,
        target_id,
        result,
        error_message
      ) VALUES (
        ${ctx.workspaceId},
        ${ctx.actorUserId},
        ${ctx.targetCollaboratorId},
        ${ctx.actionType},
        ${ctx.surface},
        ${ctx.targetId ?? null},
        ${result},
        ${errorMessage}
      )
    `;
  } catch (err) {
    logger.error('team_hub_audit_log insert failed', {
      detail: err instanceof Error ? err.message : String(err),
      actor_user_id: ctx.actorUserId,
      target_collaborator_id: ctx.targetCollaboratorId,
      action_type: ctx.actionType,
      surface: ctx.surface,
      result,
    });
  }
}

/**
 * Run `fn` while writing an audit row for the act-as action.
 *
 * Lifecycle:
 *   1. Workspace tenancy gate. Throws ActAsTenancyError if the target
 *      collaborator has no assignment / share-link in the actor's
 *      workspace. No audit row is written when the gate fails — the
 *      attempt never reached `fn`, so there is nothing to attribute.
 *   2. Run `fn`.
 *   3. On success: write `result='success'` row, return `fn`'s result.
 *   4. On failure: write `result='failure'` row with the error message,
 *      then rethrow the original error so callers see the same failure
 *      semantics.
 *
 * Audit writes are best-effort (see writeAuditRow). A broken audit
 * pipeline never blocks an action and never converts a success into a
 * failure (or vice versa).
 */
export async function actAsCollaborator<T>(
  ctx: ActAsContext,
  fn: () => Promise<T>,
): Promise<T> {
  const inWorkspace = await targetIsInWorkspace(ctx.targetCollaboratorId, ctx.workspaceId);
  if (!inWorkspace) throw new ActAsTenancyError(ctx.targetCollaboratorId);

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeAuditRow(ctx, 'failure', message);
    throw err;
  }

  await writeAuditRow(ctx, 'success', null);
  return result;
}
