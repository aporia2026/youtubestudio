import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { randomBytes } from 'node:crypto';
import { apiRoute } from '@/lib/route-helpers';
import {
  findUserByEmail,
  hashPassword,
  issueInviteToken,
  PasswordTooShortError,
} from '@/lib/users';
import { sendInviteEmail } from '@/lib/email-magic-link';
import { extractIp, writeAudit } from '@/lib/audit';
import { userIsMember } from '@/lib/workspaces';

const ALLOWED_WORKSPACE_ROLES = new Set([
  'owner',
  'member',
  'editor',
  'narrator',
  'reviewer',
  'client',
]);
const ALLOWED_LEGACY_ROLES = new Set(['editor', 'narrator', 'reviewer', 'client', 'admin']);

interface ListedUser {
  id: string;
  name: string;
  email: string | null;
  system_role: 'admin' | 'user';
  status: 'active' | 'suspended' | 'invited';
  role: string;
  color: string;
  last_login_at: Date | null;
  created_at: Date;
  has_password: boolean;
  workspace_count: number;
  workspace_names: string[] | null;
}

/**
 * GET /api/admin/users — list every user with summary fields suitable for
 * the admin table view. Emails of users who have never logged in show
 * `last_login_at = null`. Each user also carries their distinct workspace
 * names so the admin can spot un-membered accounts at a glance.
 */
export const GET = apiRoute.admin(async () => {
  const { rows } = await sql<ListedUser>`
    SELECT u.id, u.name, u.email, u.system_role, u.status, u.role, u.color,
           u.last_login_at, u.created_at,
           (u.password_hash IS NOT NULL) AS has_password,
           COUNT(DISTINCT m.workspace_id)::int AS workspace_count,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT w.name), NULL) AS workspace_names
      FROM collaborators u
      LEFT JOIN workspace_members m ON m.user_id = u.id
      LEFT JOIN workspaces w ON w.id = m.workspace_id
     GROUP BY u.id
     ORDER BY u.created_at DESC
  `;
  return NextResponse.json({ users: rows });
});

/**
 * POST /api/admin/users — create a new user.
 *
 * Body: {
 *   name: string,
 *   email: string,
 *   system_role?: 'admin' | 'user',     // default 'user'
 *   workspace_role: 'owner' | 'member' | 'editor' | 'narrator' | 'reviewer' | 'client',
 *   workspace_id?: string,               // default = admin's session workspace
 *   send_invite?: boolean,               // if true, email a magic-link invite
 *   initial_password?: string,           // if set, password is set immediately
 * }
 *
 * Exactly one of `send_invite` or `initial_password` must be present (the
 * route allows neither for token-only collaborators who never log in via
 * email + password). Returns 201 with the created user.
 */
export const POST = apiRoute.admin(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const systemRoleInput = typeof b.system_role === 'string' ? b.system_role : 'user';
  const workspaceRole = typeof b.workspace_role === 'string' ? b.workspace_role : '';
  const workspaceIdRaw = typeof b.workspace_id === 'string' ? b.workspace_id : '';
  const workspaceId = workspaceIdRaw || session.ws;
  const sendInvite = Boolean(b.send_invite);
  const initialPassword = typeof b.initial_password === 'string' ? b.initial_password : '';

  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (systemRoleInput !== 'admin' && systemRoleInput !== 'user') {
    return NextResponse.json({ error: 'system_role must be "admin" or "user"' }, { status: 400 });
  }
  if (!ALLOWED_WORKSPACE_ROLES.has(workspaceRole)) {
    return NextResponse.json({ error: 'Invalid workspace_role' }, { status: 400 });
  }
  if (sendInvite && initialPassword) {
    return NextResponse.json(
      { error: 'Provide either send_invite or initial_password, not both' },
      { status: 400 },
    );
  }

  // Defense-in-depth: even system_role='admin' can't add users to a workspace
  // they aren't a member of. The session.ws default is always safe (the admin
  // is a member by definition), but if the body explicitly names a different
  // workspace_id, we verify membership before letting the INSERT through.
  if (workspaceIdRaw && workspaceIdRaw !== session.ws) {
    const isMember = await userIsMember(session.uid, workspaceIdRaw);
    if (!isMember) {
      return NextResponse.json(
        {
          error:
            'You are not a member of that workspace. Add yourself first or pick your own workspace.',
        },
        { status: 403 },
      );
    }
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
  }

  // Map workspace role → legacy `role` column for back-compat with existing
  // queries that filter on it (narrator-db.listNarrators etc.).
  const legacyRole = ALLOWED_LEGACY_ROLES.has(workspaceRole)
    ? workspaceRole
    : workspaceRole === 'owner' || workspaceRole === 'member'
      ? 'reviewer'
      : 'reviewer';

  let passwordHash: string | null = null;
  if (initialPassword) {
    try {
      passwordHash = await hashPassword(initialPassword);
    } catch (err) {
      if (err instanceof PasswordTooShortError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const unsubscribeToken = randomBytes(24).toString('hex');
  const personalToken = randomBytes(24).toString('hex');
  const initialStatus = sendInvite ? 'invited' : 'active';

  const { rows: created } = await sql<{ id: string }>`
    INSERT INTO collaborators
      (name, email, role, roles, system_role, status, password_hash, color,
       unsubscribe_token, personal_token)
    VALUES
      (${name},
       ${email},
       ${legacyRole},
       ARRAY[${legacyRole}]::text[],
       ${systemRoleInput},
       ${initialStatus},
       ${passwordHash},
       '#7c3aed',
       ${unsubscribeToken},
       ${personalToken})
    RETURNING id
  `;
  const userId = created[0]!.id;

  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userId}, ${workspaceRole})
    ON CONFLICT DO NOTHING
  `;

  let inviteSent = false;
  if (sendInvite) {
    const { token, expiresAt } = await issueInviteToken(userId);
    await sendInviteEmail({
      recipientName: name,
      recipientEmail: email,
      token,
      expiresAt,
    });
    inviteSent = true;
  }

  await writeAudit({
    actorUserId: session.uid,
    action: 'user.create',
    targetUserId: userId,
    targetWorkspaceId: workspaceId,
    metadata: {
      name,
      email,
      system_role: systemRoleInput,
      workspace_role: workspaceRole,
      invite_sent: inviteSent,
      password_set: Boolean(passwordHash),
    },
    ipAddress: extractIp(req),
  });

  return NextResponse.json(
    {
      user: {
        id: userId,
        name,
        email,
        system_role: systemRoleInput,
        status: initialStatus,
        workspace_id: workspaceId,
        workspace_role: workspaceRole,
        invite_sent: inviteSent,
      },
    },
    { status: 201 },
  );
});
