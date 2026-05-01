/**
 * Workspace lookup helpers.
 *
 * Phase 1 supports a single workspace per user (the workspace they were
 * added to as a member). This module resolves the user's primary workspace
 * for the session payload at login time. Multi-workspace UI is deferred to
 * a later phase — when it lands, the picker will write a chosen workspace
 * id into the JWT instead of the auto-resolved one.
 */
import { sql } from '@vercel/postgres';

export interface Workspace {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: Date;
}

export interface WorkspaceMembership {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'member' | 'editor' | 'narrator' | 'reviewer' | 'client';
  joined_at: Date;
}

/**
 * Pick the user's primary workspace for the login session payload.
 *
 * Order of preference: workspaces they OWN, then workspaces where they have
 * the highest-privilege role (owner > member > editor > narrator > reviewer
 * > client), tie-broken by oldest joined_at. Deterministic so the same user
 * always lands in the same workspace until membership changes.
 */
export async function findPrimaryWorkspaceForUser(userId: string): Promise<Workspace | null> {
  if (!userId) return null;

  // role_rank assigns numeric weight to membership roles for deterministic
  // tie-breaking. Lower number = higher precedence.
  const { rows } = await sql<Workspace>`
    SELECT w.id, w.name, w.owner_user_id, w.created_at
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ${userId}
     ORDER BY
       CASE m.role
         WHEN 'owner'    THEN 0
         WHEN 'member'   THEN 1
         WHEN 'editor'   THEN 2
         WHEN 'narrator' THEN 3
         WHEN 'reviewer' THEN 4
         WHEN 'client'   THEN 5
         ELSE 99
       END,
       m.joined_at ASC,
       w.id ASC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/** All workspaces the user is a member of (any role). */
export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  if (!userId) return [];
  const { rows } = await sql<Workspace>`
    SELECT DISTINCT w.id, w.name, w.owner_user_id, w.created_at
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ${userId}
     ORDER BY w.created_at ASC
  `;
  return rows;
}

/** Roles the given user holds in the given workspace. May be empty. */
export async function getMembershipRoles(userId: string, workspaceId: string): Promise<string[]> {
  if (!userId || !workspaceId) return [];
  const { rows } = await sql<{ role: string }>`
    SELECT role FROM workspace_members
     WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
  `;
  return rows.map((r) => r.role);
}

/** True if the user is a member of the workspace in any role. */
export async function userIsMember(userId: string, workspaceId: string): Promise<boolean> {
  const roles = await getMembershipRoles(userId, workspaceId);
  return roles.length > 0;
}
