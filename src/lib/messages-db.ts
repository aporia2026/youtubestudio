/**
 * Inner-app messaging — 1:1 chat between the workspace owner and any
 * collaborator (narrator, editor, reviewer, …).
 *
 * Identity:
 *  - Both ends of every chat resolve to a `collaborators(id)` UUID.
 *  - Owner-side routes use the workspace owner (singleton for now;
 *    multi-tenant Phase 1 will swap the lookup for `session.user.id`).
 *  - Token-side routes derive the collaborator from a personal_token.
 *
 * Threads are implicit — derived from the (from, to) pair sorted by
 * created_at. There is no separate `threads` table; thread metadata
 * (last message, unread count) is computed on demand because chat
 * volumes per pair are small.
 */
import { sql } from '@vercel/postgres';

let migrated = false;

/**
 * Idempotent CREATE so dev environments without the migration runner
 * still work. Mirrors the table shape from migration 0017.
 */
export async function ensureMessagesSchema() {
  if (migrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID,
        from_collaborator_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        to_collaborator_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_messages_to_unread ON messages(to_collaborator_id) WHERE read_at IS NULL`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_messages_pair_a ON messages(from_collaborator_id, to_collaborator_id, created_at DESC)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_messages_pair_b ON messages(to_collaborator_id, from_collaborator_id, created_at DESC)`; } catch {}
    migrated = true;
  } catch (err) {
    console.error('ensureMessagesSchema error:', err);
  }
}

export interface Message {
  id: string;
  workspace_id: string | null;
  from_collaborator_id: string;
  to_collaborator_id: string;
  text: string;
  read_at: string | null;
  created_at: string;
}

export interface ThreadSummary {
  /** The OTHER party (counterpart to the viewer). */
  collaborator_id: string;
  collaborator_name: string;
  collaborator_email: string | null;
  collaborator_color: string;
  collaborator_role: string | null;
  collaborator_personal_token: string | null;
  /** Most recent message in this thread (either direction). */
  last_message_text: string | null;
  last_message_at: string | null;
  last_message_from_id: string | null;
  /** Unread count on the viewer's side — messages addressed to the viewer
   *  whose `read_at` is still null. */
  unread_count: number;
}

/**
 * Resolve the workspace owner's collaborator id. Single-workspace
 * assumption — when multi-tenant Phase 1 lands, this is replaced by
 * a session-derived lookup at the route layer.
 *
 * Falls back to NULL when no workspace exists yet (fresh DB before
 * migration 0005 has bootstrapped the admin).
 */
export async function getWorkspaceOwner(): Promise<{ id: string; name: string; email: string | null; color: string; workspace_id: string } | null> {
  try {
    const { rows } = await sql`
      SELECT w.id AS workspace_id, c.id, c.name, c.email, c.color
      FROM workspaces w
      JOIN collaborators c ON c.id = w.owner_user_id
      ORDER BY w.created_at ASC, w.id ASC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      name: (row.name as string) || 'Owner',
      email: (row.email as string | null) ?? null,
      color: (row.color as string) || '#06b6d4',
      workspace_id: row.workspace_id as string,
    };
  } catch (err) {
    console.error('getWorkspaceOwner error:', err);
    return null;
  }
}

/** Resolve a collaborator from their personal_token. Used by token-side routes. */
export async function getCollaboratorByPersonalToken(token: string): Promise<{ id: string; name: string; email: string | null; color: string; role: string } | null> {
  try {
    const { rows } = await sql`
      SELECT id, name, email, color, role
      FROM collaborators
      WHERE personal_token = ${token}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      name: (row.name as string) || 'Collaborator',
      email: (row.email as string | null) ?? null,
      color: (row.color as string) || '#7c3aed',
      role: (row.role as string) || 'reviewer',
    };
  } catch {
    return null;
  }
}

export async function createMessage(fields: {
  from_collaborator_id: string;
  to_collaborator_id: string;
  text: string;
  workspace_id?: string | null;
}): Promise<Message> {
  await ensureMessagesSchema();
  const trimmed = fields.text.trim();
  if (!trimmed) throw new Error('Message text required');
  if (trimmed.length > 10_000) throw new Error('Message too long (max 10,000 chars)');
  const { rows } = await sql`
    INSERT INTO messages (workspace_id, from_collaborator_id, to_collaborator_id, text)
    VALUES (${fields.workspace_id ?? null}, ${fields.from_collaborator_id}, ${fields.to_collaborator_id}, ${trimmed})
    RETURNING *
  `;
  return rows[0] as Message;
}

/**
 * Fetch the chat thread between two collaborators, oldest-first so the
 * client can render top-down without re-sorting. `limit` caps the result
 * — we don't paginate yet because realistic chat volumes per pair are
 * well under the cap.
 */
export async function getThread(userIdA: string, userIdB: string, limit = 500): Promise<Message[]> {
  await ensureMessagesSchema();
  const { rows } = await sql`
    SELECT * FROM messages
    WHERE (from_collaborator_id = ${userIdA} AND to_collaborator_id = ${userIdB})
       OR (from_collaborator_id = ${userIdB} AND to_collaborator_id = ${userIdA})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows as Message[];
}

/**
 * Mark every unread message addressed to `recipientId` from `fromId`
 * as read. Called when the recipient opens / focuses the thread.
 * Returns the number of messages updated.
 */
export async function markThreadRead(recipientId: string, fromId: string): Promise<number> {
  await ensureMessagesSchema();
  const { rowCount } = await sql`
    UPDATE messages
    SET read_at = NOW()
    WHERE to_collaborator_id = ${recipientId}
      AND from_collaborator_id = ${fromId}
      AND read_at IS NULL
  `;
  return rowCount ?? 0;
}

/** Count of unread messages addressed to `recipientId` across all threads. */
export async function getUnreadCountForUser(recipientId: string): Promise<number> {
  await ensureMessagesSchema();
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n FROM messages
    WHERE to_collaborator_id = ${recipientId} AND read_at IS NULL
  `;
  return (rows[0]?.n as number) || 0;
}

/**
 * Owner-side thread list: every collaborator the owner has a thread
 * with, plus an entry for any collaborator with no messages yet (so the
 * owner can initiate). Sorted by most-recent activity, with collaborators
 * who've never been messaged at the bottom.
 *
 * `viewerId` is the owner's collaborator id. The returned list does NOT
 * include the viewer themselves.
 */
export async function listThreadsForOwner(viewerId: string, opts?: { includeAllCollaborators?: boolean }): Promise<ThreadSummary[]> {
  await ensureMessagesSchema();
  const includeAll = opts?.includeAllCollaborators !== false;

  // Per-pair aggregation. Picks the LATEST message in either direction
  // and the unread count on the viewer's side. The row's "other party"
  // is whichever side isn't the viewer.
  const { rows: threadRows } = await sql`
    WITH pair_messages AS (
      SELECT
        CASE WHEN from_collaborator_id = ${viewerId} THEN to_collaborator_id ELSE from_collaborator_id END AS other_id,
        m.*
      FROM messages m
      WHERE from_collaborator_id = ${viewerId} OR to_collaborator_id = ${viewerId}
    ),
    latest_per_pair AS (
      SELECT DISTINCT ON (other_id)
        other_id, id, text, created_at, from_collaborator_id
      FROM pair_messages
      ORDER BY other_id, created_at DESC
    ),
    unread_per_pair AS (
      SELECT from_collaborator_id AS other_id, COUNT(*)::int AS n
      FROM messages
      WHERE to_collaborator_id = ${viewerId} AND read_at IS NULL
      GROUP BY from_collaborator_id
    )
    SELECT
      lp.other_id,
      lp.text AS last_message_text,
      lp.created_at AS last_message_at,
      lp.from_collaborator_id AS last_message_from_id,
      COALESCE(up.n, 0) AS unread_count
    FROM latest_per_pair lp
    LEFT JOIN unread_per_pair up ON up.other_id = lp.other_id
  `;

  const haveThread = new Map<string, { last_message_text: string; last_message_at: string; last_message_from_id: string; unread_count: number }>();
  for (const r of threadRows) {
    haveThread.set(r.other_id as string, {
      last_message_text: (r.last_message_text as string) ?? '',
      last_message_at: r.last_message_at as string,
      last_message_from_id: r.last_message_from_id as string,
      unread_count: (r.unread_count as number) || 0,
    });
  }

  // Pull collaborator metadata in one query for both groups.
  let collabRows: Array<{ id: string; name: string; email: string | null; color: string; role: string | null; personal_token: string | null }> = [];
  if (includeAll) {
    const { rows } = await sql`
      SELECT id, name, email, color, role, personal_token
      FROM collaborators
      WHERE id != ${viewerId}
      ORDER BY name ASC
    `;
    collabRows = rows as typeof collabRows;
  } else if (haveThread.size > 0) {
    const ids = Array.from(haveThread.keys());
    const { rows } = await sql.query(
      `SELECT id, name, email, color, role, personal_token
         FROM collaborators
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    collabRows = rows as typeof collabRows;
  }

  const summaries: ThreadSummary[] = collabRows.map(c => {
    const thread = haveThread.get(c.id);
    return {
      collaborator_id: c.id,
      collaborator_name: c.name || 'Collaborator',
      collaborator_email: c.email,
      collaborator_color: c.color || '#7c3aed',
      collaborator_role: c.role,
      collaborator_personal_token: c.personal_token,
      last_message_text: thread?.last_message_text ?? null,
      last_message_at: thread?.last_message_at ?? null,
      last_message_from_id: thread?.last_message_from_id ?? null,
      unread_count: thread?.unread_count ?? 0,
    };
  });

  // Sort: most recent activity first; collaborators with no thread yet at the bottom.
  summaries.sort((a, b) => {
    if (a.last_message_at && b.last_message_at) {
      return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
    }
    if (a.last_message_at) return -1;
    if (b.last_message_at) return 1;
    return a.collaborator_name.localeCompare(b.collaborator_name);
  });

  return summaries;
}
