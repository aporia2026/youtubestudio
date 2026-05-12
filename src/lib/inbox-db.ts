import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';
import { ensureReviewSchema } from '@/lib/review-db';
import { ensureNarratorSchema } from '@/lib/narrator-db';

// ---------------------------------------------------------------------------
// Global comments inbox — aggregates `narration_take_comments` and
// `review_comments` into a unified, role-aware view.
//
// The inbox is owner-facing only. Every query is scoped by `workspace_id`
// (the caller is expected to read this from the session — never from the
// request body).
// ---------------------------------------------------------------------------

export type InboxSource = 'narration' | 'review';
export type InboxAuthorRole = 'owner' | 'narrator' | 'editor' | 'reviewer';
export type InboxFilter = 'unresolved' | 'resolved' | 'all';

/**
 * One row in the inbox feed. The shape is intentionally flat (no nested
 * objects) so the page can group / filter / search without a normalization
 * pass on the client. Project context is denormalised onto every row to
 * keep the API to a single round-trip.
 */
export interface InboxComment {
  source: InboxSource;
  id: string;
  text: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  author_name: string;
  author_color: string;
  author_role: InboxAuthorRole;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
  /** When set, this row is a reply to another comment. Replies are
   *  surfaced in the inbox so the owner sees every comment they (or
   *  collaborators) wrote — even threaded responses. The matching parent
   *  is reachable via the deep_link, which always lands on the same
   *  take/version. */
  parent_id: string | null;
  /** Set when this comment was authored as an editor "fix note" replying to
   *  earlier feedback. The original feedback lives at the same coordinates
   *  on the previous take/version. */
  fix_for_comment_id: string | null;
  /** Number of direct replies (parent_id = this.id). */
  reply_count: number;
  // Project context
  project_id: string;
  project_title: string;
  // Source-specific anchors. Exactly one pair is populated per row.
  /** Narration: identifies the take this comment is anchored to. */
  take_id: string | null;
  take_number: number | null;
  /** Narration: identifies the parent assignment (used for the deep link). */
  assignment_id: string | null;
  /** Review: identifies the version this comment is anchored to. */
  version_id: string | null;
  version_number: number | null;
}

/**
 * Build the deep-link URL that takes the owner from an inbox row to the
 * exact comment in its source page. The destination pages must read the
 * `comment` query param to scroll/highlight.
 */
export function inboxDeepLink(row: InboxComment): string {
  if (row.source === 'narration') {
    if (!row.project_id || !row.take_id) return '#';
    return `/projects/${row.project_id}?tab=narration&take=${row.take_id}&comment=${row.id}`;
  }
  if (row.source === 'review') {
    if (!row.project_id || !row.version_id) return '#';
    // /reviews/[id] is the project-metadata page; /reviews/[id]/play is the
    // playback surface that hosts ReviewPage + the comments timeline. The
    // inbox always wants the playback view.
    return `/reviews/${row.project_id}/play?v=${row.version_id}&comment=${row.id}`;
  }
  return '#';
}

/**
 * Hard ceiling on rows returned in a single page request. The page groups
 * client-side, so we want enough rows for the role/person panes to be
 * complete; if a workspace ever crosses this we'll add cursor pagination.
 * Picked deliberately high — at 1k rows the payload is ~250 KB JSON which
 * gzip-compresses to ~30 KB.
 */
const INBOX_HARD_LIMIT = 1000;

export interface ListInboxOpts {
  filter?: InboxFilter;
  /** Case-insensitive substring search across comment text + author name. */
  q?: string;
  /** Restrict to a specific project. */
  project_id?: string;
  /** Restrict to a specific role bucket. */
  role?: InboxAuthorRole;
  /** Restrict to a specific author name (case-insensitive equality). */
  author_name?: string;
  limit?: number;
}

/**
 * Fetch top-level comments for the inbox view of `workspaceId`.
 *
 * Strategy: UNION ALL across the two comment tables, joined to their
 * respective project context, then filter in the outer query. The two
 * inner SELECTs return identical column shapes so the union is cheap and
 * doesn't need a wrapper CAST per column at read time.
 */
export async function listInboxComments(
  workspaceId: string,
  opts: ListInboxOpts = {},
): Promise<InboxComment[]> {
  // Self-heal both schemas — same idempotent pattern used elsewhere. Safe
  // to call on every request; both helpers short-circuit after the first
  // successful pass.
  await Promise.all([ensureReviewSchema(), ensureNarratorSchema()]);

  const filter: InboxFilter = opts.filter ?? 'unresolved';
  const limit = Math.min(opts.limit ?? INBOX_HARD_LIMIT, INBOX_HARD_LIMIT);
  const q = opts.q?.trim() || null;
  const projectId = opts.project_id ?? null;
  const role = opts.role ?? null;
  const authorName = opts.author_name?.trim() || null;

  // Reply counts via correlated COUNT subqueries — at the row scale we're
  // targeting (≤ 1k top-level), this is faster than a join + GROUP BY and
  // keeps the query readable. Each subquery is an index lookup on the
  // already-indexed `parent_id` column.
  try {
    const { rows } = await sql<InboxComment>`
      WITH inbox AS (
        SELECT
          'narration'::text                                 AS source,
          c.id                                              AS id,
          c.text                                            AS text,
          c.timestamp_ms                                    AS timestamp_ms,
          c.end_timestamp_ms                                AS end_timestamp_ms,
          c.author_name                                     AS author_name,
          c.author_color                                    AS author_color,
          c.author_role                                     AS author_role,
          c.resolved                                        AS resolved,
          c.resolved_at                                     AS resolved_at,
          c.created_at                                      AS created_at,
          c.parent_id                                       AS parent_id,
          c.fix_for_comment_id                              AS fix_for_comment_id,
          (SELECT COUNT(*)::int FROM narration_take_comments r WHERE r.parent_id = c.id) AS reply_count,
          p.id                                              AS project_id,
          p.title                                           AS project_title,
          t.id                                              AS take_id,
          t.take_number                                     AS take_number,
          a.id                                              AS assignment_id,
          NULL::uuid                                        AS version_id,
          NULL::int                                         AS version_number
        FROM narration_take_comments c
        JOIN narrator_takes t        ON t.id = c.take_id
        JOIN narrator_sections s     ON s.id = t.section_id
        JOIN narrator_assignments a  ON a.id = s.assignment_id
        JOIN projects p              ON p.id = a.project_id
        WHERE c.workspace_id = ${workspaceId}::uuid

        UNION ALL

        SELECT
          'review'::text                                    AS source,
          c.id                                              AS id,
          c.text                                            AS text,
          c.timestamp_ms                                    AS timestamp_ms,
          c.end_timestamp_ms                                AS end_timestamp_ms,
          c.author_name                                     AS author_name,
          c.author_color                                    AS author_color,
          c.author_role                                     AS author_role,
          c.resolved                                        AS resolved,
          c.resolved_at                                     AS resolved_at,
          c.created_at                                      AS created_at,
          c.parent_id                                       AS parent_id,
          c.fix_for_comment_id                              AS fix_for_comment_id,
          (SELECT COUNT(*)::int FROM review_comments r WHERE r.parent_id = c.id) AS reply_count,
          rp.id                                             AS project_id,
          rp.title                                          AS project_title,
          NULL::uuid                                        AS take_id,
          NULL::int                                         AS take_number,
          NULL::uuid                                        AS assignment_id,
          v.id                                              AS version_id,
          v.version_number                                  AS version_number
        FROM review_comments c
        JOIN review_versions v       ON v.id = c.version_id
        JOIN review_projects rp      ON rp.id = v.project_id
        WHERE c.workspace_id = ${workspaceId}::uuid
      )
      SELECT * FROM inbox
       WHERE (${filter}::text = 'all'
              OR (${filter}::text = 'unresolved' AND resolved = FALSE)
              OR (${filter}::text = 'resolved'   AND resolved = TRUE))
         AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
         AND (${role}::text IS NULL OR author_role = ${role}::text)
         AND (${authorName}::text IS NULL OR LOWER(author_name) = LOWER(${authorName}::text))
         AND (${q}::text IS NULL
              OR text ILIKE '%' || ${q}::text || '%'
              OR author_name ILIKE '%' || ${q}::text || '%')
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows;
  } catch (err) {
    logger.error('listInboxComments error', { detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Cheap COUNT(*) of unresolved top-level comments for the badge + header
 * totals. Hits the partial indexes from migration 0056.
 */
export async function countUnresolvedInbox(workspaceId: string): Promise<number> {
  await Promise.all([ensureReviewSchema(), ensureNarratorSchema()]);
  try {
    // Counts every unresolved comment (top-level + replies) so the
    // sidebar badge matches what the inbox page actually displays.
    const { rows } = await sql<{ total: number }>`
      SELECT
        (SELECT COUNT(*)::int FROM narration_take_comments
          WHERE workspace_id = ${workspaceId}::uuid AND resolved = FALSE)
        +
        (SELECT COUNT(*)::int FROM review_comments
          WHERE workspace_id = ${workspaceId}::uuid AND resolved = FALSE)
        AS total
    `;
    return rows[0]?.total ?? 0;
  } catch (err) {
    logger.error('countUnresolvedInbox error', { detail: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/**
 * Mark an inbox comment resolved. Routes through to the right table based
 * on `source` and re-scopes by `workspace_id` so a forged comment id from
 * another workspace cannot be flipped.
 */
export async function resolveInboxComment(
  workspaceId: string,
  source: InboxSource,
  commentId: string,
  resolvedBy: string,
): Promise<boolean> {
  if (source === 'narration') {
    const { rowCount } = await sql`
      UPDATE narration_take_comments
         SET resolved = TRUE, resolved_by = ${resolvedBy}, resolved_at = NOW()
       WHERE id = ${commentId}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `;
    return (rowCount ?? 0) > 0;
  }
  if (source === 'review') {
    const { rowCount } = await sql`
      UPDATE review_comments
         SET resolved = TRUE, resolved_by = ${resolvedBy}, resolved_at = NOW()
       WHERE id = ${commentId}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `;
    return (rowCount ?? 0) > 0;
  }
  return false;
}

export interface InboxBulkItem {
  source: InboxSource;
  commentId: string;
}

/**
 * Apply the same resolved/unresolved state to many comments at once. One
 * UPDATE per source so a mixed selection (narration + review in the same
 * batch) costs at most two round-trips. Re-scoped by workspace_id like
 * every other inbox write — a forged id from another tenant can't be
 * flipped.
 *
 * Returns the number of rows actually flipped so the caller can warn the
 * user if some items were filtered out (deleted mid-batch, cross-tenant,
 * etc).
 */
export async function resolveInboxCommentsBulk(
  workspaceId: string,
  items: InboxBulkItem[],
  resolved: boolean,
  resolvedBy: string,
): Promise<number> {
  if (items.length === 0) return 0;
  const narrationIds = items.filter(i => i.source === 'narration').map(i => i.commentId);
  const reviewIds   = items.filter(i => i.source === 'review').map(i => i.commentId);
  let total = 0;
  // Array params require sql.query() rather than the template-literal
  // form (which only accepts primitives). Same pattern used by messages-db
  // and auto-pipeline/db. workspace_id is read from the session by the
  // caller — never trust an id from the request body alone.
  if (narrationIds.length > 0) {
    if (resolved) {
      const { rowCount } = await sql.query(
        `UPDATE narration_take_comments
            SET resolved = TRUE, resolved_by = $1, resolved_at = NOW()
          WHERE workspace_id = $2::uuid
            AND id = ANY($3::uuid[])`,
        [resolvedBy, workspaceId, narrationIds],
      );
      total += rowCount ?? 0;
    } else {
      const { rowCount } = await sql.query(
        `UPDATE narration_take_comments
            SET resolved = FALSE, resolved_by = NULL, resolved_at = NULL
          WHERE workspace_id = $1::uuid
            AND id = ANY($2::uuid[])`,
        [workspaceId, narrationIds],
      );
      total += rowCount ?? 0;
    }
  }
  if (reviewIds.length > 0) {
    if (resolved) {
      const { rowCount } = await sql.query(
        `UPDATE review_comments
            SET resolved = TRUE, resolved_by = $1, resolved_at = NOW()
          WHERE workspace_id = $2::uuid
            AND id = ANY($3::uuid[])`,
        [resolvedBy, workspaceId, reviewIds],
      );
      total += rowCount ?? 0;
    } else {
      const { rowCount } = await sql.query(
        `UPDATE review_comments
            SET resolved = FALSE, resolved_by = NULL, resolved_at = NULL
          WHERE workspace_id = $1::uuid
            AND id = ANY($2::uuid[])`,
        [workspaceId, reviewIds],
      );
      total += rowCount ?? 0;
    }
  }
  return total;
}

/**
 * Inverse of `resolveInboxComment`. Re-opens a comment from the inbox.
 */
export async function unresolveInboxComment(
  workspaceId: string,
  source: InboxSource,
  commentId: string,
): Promise<boolean> {
  if (source === 'narration') {
    const { rowCount } = await sql`
      UPDATE narration_take_comments
         SET resolved = FALSE, resolved_by = NULL, resolved_at = NULL
       WHERE id = ${commentId}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `;
    return (rowCount ?? 0) > 0;
  }
  if (source === 'review') {
    const { rowCount } = await sql`
      UPDATE review_comments
         SET resolved = FALSE, resolved_by = NULL, resolved_at = NULL
       WHERE id = ${commentId}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `;
    return (rowCount ?? 0) > 0;
  }
  return false;
}
