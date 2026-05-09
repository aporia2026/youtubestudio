/**
 * Server-side data fetch for /team-hub.
 *
 * Two distinct populations feed the roster:
 *
 *   1. Workspace-scoped collaborators — anyone in the global `collaborators`
 *      table who has at least one narrator_assignment, editor_assignment, or
 *      review_share_link in the actor's workspace. Collaborators are global
 *      by design (see migration 0003 — auth was extended onto `collaborators`
 *      rather than splitting into a separate `users` table) but the team
 *      hub deliberately filters to "people I actually work with in this
 *      workspace" so the rail isn't polluted with teammates from other
 *      tenants.
 *
 *   2. Channel editors — rows in the `channel_editors` table joined to
 *      `channels` filtered by workspace. Distinct from collaborators
 *      (different table, simpler schema, no personal token, no roles
 *      column) so they show up as their own roster-entry kind with the
 *      synthetic 'channel_editor' role.
 *
 * The two queries run in parallel and are merged + sorted in JS. Sort
 * order: most recent activity first, then alphabetic. Channel editors
 * intermix with collaborators — the user wants ONE roster view, not two.
 */
import { sql } from '@vercel/postgres';
import type { RosterEntry, TeamHubRoster } from './team-hub-types';
import { deterministicColor } from './team-hub-types';

interface CollaboratorRow {
  id: string;
  name: string;
  email: string | null;
  color: string;
  role: string;
  roles: string[] | null;
  personal_token: string | null;
  last_activity: string | null;
  narrator_count: number;
  editor_count: number;
  review_count: number;
}

interface ChannelEditorRow {
  id: string;
  name: string;
  email: string | null;
  channel_id: string;
  channel_name: string;
  updated_at: string | null;
  channel_count: number;
}

/**
 * Fetch every collaborator with at least one assignment / share link in
 * the workspace, with per-source counts and the workspace-scoped
 * last-activity timestamp.
 *
 * The CTE `scoped` enumerates the (collaborator_id, last_accessed_at)
 * pairs from the three source tables; the outer SELECT joins back to
 * `collaborators` and computes the per-source counts via correlated
 * subqueries (each scoped by workspace_id so cross-tenant rows don't
 * inflate the count).
 */
async function fetchScopedCollaborators(workspaceId: string): Promise<CollaboratorRow[]> {
  const { rows } = await sql<CollaboratorRow>`
    WITH scoped AS (
      SELECT narrator_id AS id, last_accessed_at
        FROM narrator_assignments
       WHERE workspace_id = ${workspaceId}
         AND narrator_id IS NOT NULL
      UNION ALL
      SELECT editor_id AS id, last_accessed_at
        FROM editor_assignments
       WHERE workspace_id = ${workspaceId}
      UNION ALL
      SELECT collaborator_id AS id, last_accessed_at
        FROM review_share_links
       WHERE workspace_id = ${workspaceId}
         AND collaborator_id IS NOT NULL
    ),
    agg AS (
      SELECT id, MAX(last_accessed_at) AS last_activity
        FROM scoped
       GROUP BY id
    )
    SELECT
      c.id,
      c.name,
      c.email,
      c.color,
      c.role,
      c.roles,
      c.personal_token,
      agg.last_activity,
      (SELECT COUNT(*)::int FROM narrator_assignments
         WHERE narrator_id = c.id AND workspace_id = ${workspaceId}) AS narrator_count,
      (SELECT COUNT(*)::int FROM editor_assignments
         WHERE editor_id = c.id AND workspace_id = ${workspaceId}) AS editor_count,
      (SELECT COUNT(*)::int FROM review_share_links
         WHERE collaborator_id = c.id AND workspace_id = ${workspaceId}) AS review_count
      FROM collaborators c
      JOIN agg ON agg.id = c.id
     ORDER BY agg.last_activity DESC NULLS LAST, c.name ASC
  `;
  return rows;
}

/**
 * Fetch every channel editor whose channel lives in the actor's
 * workspace. One row per (channel_editor, channel) pair — a single
 * person appearing on two channels shows up twice (which is correct: the
 * left rail surfaces them as two separate roster entries because their
 * scope on each channel is independent).
 */
async function fetchScopedChannelEditors(workspaceId: string): Promise<ChannelEditorRow[]> {
  const { rows } = await sql<ChannelEditorRow>`
    SELECT
      ce.id,
      ce.name,
      ce.email,
      ce.channel_id,
      ch.name AS channel_name,
      ce.updated_at,
      1 AS channel_count
      FROM channel_editors ce
      JOIN channels ch ON ch.id = ce.channel_id
     WHERE ch.workspace_id = ${workspaceId}
     ORDER BY LOWER(ce.name) ASC, ch.name ASC
  `;
  return rows;
}

/** Resolve a collaborator's `roles[]` array, falling back to the legacy
 *  scalar `role` for rows that haven't been backfilled. Mirrors the same
 *  helper in team-db.ts but inlined here so the team-hub data layer
 *  doesn't depend on the legacy team-db module. */
function resolveRoles(row: CollaboratorRow): string[] {
  if (Array.isArray(row.roles) && row.roles.length > 0) return row.roles;
  return [row.role];
}

/**
 * Build the unified roster. Public entry point — called by the route
 * handler with `session.ws`.
 *
 * Sort order: most recent activity first, then alphabetic by name. The
 * groups themselves are interleaved (a recently-active narrator can
 * appear above an idle editor) — the left-rail component groups visually
 * by role at render time using `entryGroups` from team-hub-types.
 */
export async function getTeamHubRoster(workspaceId: string): Promise<TeamHubRoster> {
  const [collabs, channelEditors] = await Promise.all([
    fetchScopedCollaborators(workspaceId),
    fetchScopedChannelEditors(workspaceId),
  ]);

  const collabEntries: RosterEntry[] = collabs.map((row) => ({
    id: row.id,
    kind: 'collaborator',
    name: row.name,
    email: row.email,
    color: row.color || deterministicColor(row.id),
    roles: resolveRoles(row),
    personal_token: row.personal_token,
    last_activity: row.last_activity,
    narrator_assignment_count: row.narrator_count,
    editor_assignment_count: row.editor_count,
    review_link_count: row.review_count,
    channel_count: 0,
    channel_id: null,
    channel_name: null,
  }));

  const channelEntries: RosterEntry[] = channelEditors.map((row) => ({
    // Compose channel-editor id with channel id so the same person on two
    // channels gets two distinct roster entries in the URL space. The
    // bare `ce.id` would collide if a person edits multiple channels.
    id: `${row.id}@${row.channel_id}`,
    kind: 'channel_editor',
    name: row.name,
    email: row.email,
    color: deterministicColor(row.id),
    roles: ['channel_editor'],
    personal_token: null,
    last_activity: row.updated_at,
    narrator_assignment_count: 0,
    editor_assignment_count: 0,
    review_link_count: 0,
    channel_count: row.channel_count,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
  }));

  // Merge + re-sort by last_activity DESC, then name ASC.
  const merged = [...collabEntries, ...channelEntries].sort((a, b) => {
    const la = a.last_activity ? new Date(a.last_activity).getTime() : 0;
    const lb = b.last_activity ? new Date(b.last_activity).getTime() : 0;
    if (la !== lb) return lb - la;
    return a.name.localeCompare(b.name);
  });

  return { entries: merged };
}
