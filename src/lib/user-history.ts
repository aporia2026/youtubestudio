/**
 * Server-side persistence for the seven generator history panels
 * (script, ideas, voiceover, seo, thumbnail, qa, production_doc).
 * Backs the API routes under /api/history. Frontend code never imports
 * from here directly — it goes through the fetch wrappers in
 * `src/lib/history.ts`.
 *
 * Tenancy + auth are enforced at the route layer (`apiRoute.authed`)
 * and re-enforced here: every query takes a `(workspaceId,
 * collaboratorId)` pair as the first scoping arguments. Callers must
 * pass them from the verified session — never trust user-supplied ids.
 *
 * Caps are enforced server-side after every insert (KIND_CAPS map
 * below). The numbers mirror the localStorage MAX_*_ENTRIES constants
 * from `src/lib/history.ts` so the user experience is unchanged.
 */
import { sql } from '@vercel/postgres';
import { HISTORY_KINDS, isHistoryKind, type HistoryKind } from './user-history-types';

// Re-export for callers that already import from this module — keeps
// the ergonomic single-import pattern even though the literal enum
// now lives in a dep-free types file.
export { HISTORY_KINDS, isHistoryKind, type HistoryKind };

/**
 * Per-kind retention caps. Match the localStorage limits from
 * `src/lib/history.ts` exactly. Bigger payload → smaller cap.
 */
export const KIND_CAPS: Record<HistoryKind, number> = {
  script: 50,
  ideas: 100,
  voiceover: 100,
  seo: 50,
  thumbnail: 50,
  qa: 50,
  production_doc: 30,
  // Hook-first Shorts batches. Cap matches long-form `ideas` since the
  // payload shape + size are comparable (N idea cards per batch).
  shorts_ideas: 100,
};

/**
 * Hard ceiling on a single payload, measured in **UTF-8 bytes** as
 * the value will sit on the wire and inside Postgres JSONB. Computed
 * via `Buffer.byteLength(json, 'utf8')` (NOT `json.length`, which
 * counts UTF-16 code units and would let a 256K-emoji blob through).
 *
 * Defence against pathological clients (e.g. someone pasting a 10MB
 * script body). The script-history MAX_SCRIPT_LENGTH is already 15K
 * chars; this leaves comfortable margin for the surrounding metadata
 * + the heavier kinds (qa, production_doc) that store full result
 * blobs. A row above this is rejected with a 413-style error at the
 * API layer.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB per row

export interface UserHistoryRow {
  id: string;
  kind: HistoryKind;
  payload: unknown;
  client_id: string | null;
  created_at: string;
}

/**
 * Fetch up to the kind's cap of recent entries for one user, newest
 * first. Pure read — no side effects.
 */
export async function listUserHistory(
  workspaceId: string,
  collaboratorId: string,
  kind: HistoryKind,
): Promise<UserHistoryRow[]> {
  const limit = KIND_CAPS[kind];
  const { rows } = await sql<UserHistoryRow>`
    SELECT id, kind, payload, client_id, created_at
      FROM user_history
     WHERE workspace_id = ${workspaceId}
       AND collaborator_id = ${collaboratorId}
       AND kind = ${kind}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

/**
 * Saves an entry and trims older entries beyond the per-kind cap.
 *
 * `clientId` is OPTIONAL and only used by the one-shot localStorage
 * migration. If supplied and a row with the same (workspace,
 * collaborator, kind, client_id) already exists, the insert is a
 * no-op and the existing row is returned — that's how the migration
 * is made idempotent on a re-run.
 *
 * Returns the row that now lives in the DB (either the newly-inserted
 * one or the pre-existing match).
 */
export async function saveUserHistory(
  workspaceId: string,
  collaboratorId: string,
  kind: HistoryKind,
  payload: unknown,
  clientId?: string,
): Promise<UserHistoryRow> {
  const payloadJson = JSON.stringify(payload);
  // `Buffer.byteLength(_, 'utf8')` measures the actual on-the-wire
  // byte size; `json.length` would count UTF-16 code units and let a
  // payload of mostly-emoji slip past with ~4× more bytes than the
  // cap allows.
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload too large: ${payloadBytes} > ${MAX_PAYLOAD_BYTES} bytes`);
  }

  // Idempotent insert: ON CONFLICT triggers when (workspace,
  // collaborator, kind, client_id) collides with the partial unique
  // index from migration 0049. RETURNING + a follow-up SELECT covers
  // the no-op case (ON CONFLICT DO NOTHING returns zero rows).
  const inserted = await sql<UserHistoryRow>`
    INSERT INTO user_history (workspace_id, collaborator_id, kind, payload, client_id)
    VALUES (${workspaceId}, ${collaboratorId}, ${kind}, ${payloadJson}::jsonb, ${clientId ?? null})
    ON CONFLICT (workspace_id, collaborator_id, kind, client_id) WHERE client_id IS NOT NULL
    DO NOTHING
    RETURNING id, kind, payload, client_id, created_at
  `;

  let row = inserted.rows[0];
  if (!row && clientId) {
    // Conflict path: pull the existing row so the caller sees the
    // canonical id/timestamp. A missing row here would mean the
    // unique index is gone — fail loud rather than mask it.
    const existing = await sql<UserHistoryRow>`
      SELECT id, kind, payload, client_id, created_at
        FROM user_history
       WHERE workspace_id = ${workspaceId}
         AND collaborator_id = ${collaboratorId}
         AND kind = ${kind}
         AND client_id = ${clientId}
       LIMIT 1
    `;
    row = existing.rows[0];
    if (!row) {
      throw new Error(
        `saveUserHistory: insert was skipped by ON CONFLICT but no existing row found ` +
        `for (workspace, collaborator, kind=${kind}, client_id=${clientId})`,
      );
    }
    // No trim needed when the insert was a no-op — the row count
    // didn't grow.
    return row;
  }

  // Trim oldest beyond cap. Cheap on the (workspace, collaborator,
  // kind, created_at DESC) index. Skipped on the conflict no-op path
  // because nothing changed.
  await trimToCap(workspaceId, collaboratorId, kind);

  return row;
}

/**
 * Replace the payload of an existing entry. Used by the
 * thumbnail/production-doc panels to attach generated images / row
 * patches after the initial save (the client merges, then PATCHes the
 * full updated payload back). Scoped to (workspace, collaborator) for
 * the same anti-leak reason as `deleteUserHistoryEntry`. Returns true
 * iff a row was actually updated.
 */
/**
 * Fetch a single user_history entry by id, scoped to the caller's
 * (workspace_id, collaborator_id). Returns null when the id doesn't
 * exist OR belongs to another scope — same 404-not-403 pattern the
 * other helpers use so cross-scope ids never leak existence.
 */
export async function getUserHistoryEntry(
  workspaceId: string,
  collaboratorId: string,
  id: string,
): Promise<UserHistoryRow | null> {
  const { rows } = await sql<UserHistoryRow>`
    SELECT id, kind, payload, client_id, created_at
      FROM user_history
     WHERE id = ${id}::uuid
       AND workspace_id = ${workspaceId}
       AND collaborator_id = ${collaboratorId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateUserHistoryEntry(
  workspaceId: string,
  collaboratorId: string,
  id: string,
  payload: unknown,
): Promise<boolean> {
  const payloadJson = JSON.stringify(payload);
  // `Buffer.byteLength(_, 'utf8')` measures the actual on-the-wire
  // byte size; `json.length` would count UTF-16 code units and let a
  // payload of mostly-emoji slip past with ~4× more bytes than the
  // cap allows.
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload too large: ${payloadBytes} > ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const { rowCount } = await sql`
    UPDATE user_history
       SET payload = ${payloadJson}::jsonb
     WHERE id = ${id}
       AND workspace_id = ${workspaceId}
       AND collaborator_id = ${collaboratorId}
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Delete one entry by id. Scoped to the caller's (workspace,
 * collaborator) so a leaked id from another tenant or another user
 * can't be used to delete cross-scope. Returns true iff a row was
 * actually removed.
 */
export async function deleteUserHistoryEntry(
  workspaceId: string,
  collaboratorId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await sql`
    DELETE FROM user_history
     WHERE id = ${id}
       AND workspace_id = ${workspaceId}
       AND collaborator_id = ${collaboratorId}
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Clear every entry of one kind for this user in this workspace.
 * Returns the row count for telemetry / UI confirmation.
 */
export async function clearUserHistory(
  workspaceId: string,
  collaboratorId: string,
  kind: HistoryKind,
): Promise<number> {
  const { rowCount } = await sql`
    DELETE FROM user_history
     WHERE workspace_id = ${workspaceId}
       AND collaborator_id = ${collaboratorId}
       AND kind = ${kind}
  `;
  return rowCount ?? 0;
}

/**
 * Removes rows beyond the per-kind cap, oldest first. Exported for
 * tests + potential admin use; the public save/restore APIs call it
 * automatically.
 *
 * Implementation: select the ids of rows to DELETE via an `OFFSET cap`
 * scan in newest-first order on the composite index, then DELETE them
 * by id. The OFFSET makes the planner stop after `cap` rows — total
 * cost is O(cap) regardless of partition size.
 *
 * Tiebreaker: `ORDER BY created_at DESC, id DESC`. Without the `id`
 * tiebreaker, two rows sharing a millisecond timestamp (possible
 * during the migration upload's tight loop) have undefined ordering,
 * which means a just-inserted row could fall outside the kept set
 * and be deleted. Migration 0049's index uses the same composite so
 * this query stays index-only.
 */
export async function trimToCap(
  workspaceId: string,
  collaboratorId: string,
  kind: HistoryKind,
): Promise<number> {
  const cap = KIND_CAPS[kind];
  const { rowCount } = await sql`
    DELETE FROM user_history
     WHERE id IN (
       SELECT id FROM user_history
        WHERE workspace_id = ${workspaceId}
          AND collaborator_id = ${collaboratorId}
          AND kind = ${kind}
        ORDER BY created_at DESC, id DESC
        OFFSET ${cap}
     )
  `;
  return rowCount ?? 0;
}
