/**
 * Append-only admin audit log writer. Every /api/admin/** mutation calls
 * `writeAudit` so support / forensics has a complete trail of who did what
 * when. The route handler supplies the request to extract the IP address.
 *
 * Best-effort: the writer never throws. A failed audit write logs to
 * stderr and lets the originating request succeed — losing an audit row
 * is an integrity issue, but failing the user-facing action because logging
 * broke is worse.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';

export type AdminAction =
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.suspend'
  | 'user.unsuspend'
  | 'user.set_password'
  | 'user.issue_invite'
  | 'user.issue_password_reset'
  | 'user.regenerate_token'
  | 'workspace.member_add'
  | 'workspace.member_remove'
  | 'workspace.create'
  | 'workspace.update'
  | 'workspace.delete';

export interface WriteAuditParams {
  actorUserId: string;
  action: AdminAction;
  targetUserId?: string | null;
  targetWorkspaceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAudit(params: WriteAuditParams): Promise<void> {
  try {
    await sql`
      INSERT INTO admin_audit_log
        (actor_user_id, action, target_user_id, target_workspace_id, metadata, ip_address)
      VALUES
        (${params.actorUserId},
         ${params.action},
         ${params.targetUserId ?? null},
         ${params.targetWorkspaceId ?? null},
         ${JSON.stringify(params.metadata ?? {})}::jsonb,
         ${params.ipAddress ?? null})
    `;
  } catch (err) {
    logger.error('audit write failed', {
      detail: err instanceof Error ? err.message : String(err),
      action: params.action,
      actor: params.actorUserId,
    });
  }
}

export interface AuditEntry {
  id: string;
  actor_user_id: string;
  action: string;
  target_user_id: string | null;
  target_workspace_id: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: Date;
  // Joined fields:
  actor_email: string | null;
  actor_name: string | null;
  target_email: string | null;
  target_name: string | null;
}

/** List recent audit entries with actor / target email + name joined in. */
export async function listAuditLog(
  opts: { limit?: number; offset?: number; action?: string } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (opts.action) {
    const { rows } = await sql<AuditEntry>`
      SELECT a.*,
             actor.email AS actor_email, actor.name AS actor_name,
             tgt.email   AS target_email, tgt.name   AS target_name
        FROM admin_audit_log a
        LEFT JOIN collaborators actor ON actor.id = a.actor_user_id
        LEFT JOIN collaborators tgt   ON tgt.id   = a.target_user_id
       WHERE a.action = ${opts.action}
       ORDER BY a.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  }
  const { rows } = await sql<AuditEntry>`
    SELECT a.*,
           actor.email AS actor_email, actor.name AS actor_name,
           tgt.email   AS target_email, tgt.name   AS target_name
      FROM admin_audit_log a
      LEFT JOIN collaborators actor ON actor.id = a.actor_user_id
      LEFT JOIN collaborators tgt   ON tgt.id   = a.target_user_id
     ORDER BY a.created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
}

/** Best-effort IP extraction. Honours x-forwarded-for then x-real-ip. */
export function extractIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri;
  return null;
}
