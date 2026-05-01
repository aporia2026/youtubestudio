/**
 * Workspace-scoping helpers for API route handlers.
 *
 * The proxy at src/proxy.ts already gates every /api/* request behind a
 * valid Phase-1 session — but inside a route handler, raw SQL still has
 * to add `WHERE workspace_id = $ws` to prevent cross-tenant access. These
 * helpers make that boilerplate one line.
 *
 * Two patterns:
 *
 *   1. `assertOwnsResource(table, id, workspaceId)` — call this BEFORE a
 *      mutation against a single row. Throws ResourceNotInWorkspaceError
 *      (which the route turns into a 404) if the row isn't in the user's
 *      workspace. Cheap (single SELECT 1 LIMIT 1).
 *
 *   2. `getResourceInWorkspace(table, id, workspaceId)` — fetch a single
 *      row scoped to the workspace. Returns null if not found.
 *
 * Table names are sanitised through an allowlist so this can never become
 * a SQL injection vector if someone wires user input into `table`.
 */
import { sql } from '@vercel/postgres';

/**
 * Tables that carry a `workspace_id` column. Mirrors the list in
 * src/lib/migrations/_workspace_scoped_tables.ts (root + child tenant
 * tables) — kept here as an explicit allowlist so a typo can't allow
 * arbitrary table names through the helpers.
 */
export const SCOPED_TABLES = [
  'projects',
  'channels',
  'niches',
  'competitor_channels',
  'video_ideas',
  'schedule_items',
  'series',
  'review_projects',
  'workflow_drafts',
  'saved_channel_names',
  'templates',
  'reference_library',
  'google_auth_tokens',
  'scripts',
  'qa_sessions',
  'media_assets',
  'youtube_references',
  'oauth_tokens',
  'competitor_videos',
  'series_parts',
  'editor_assignments',
  'narrator_assignments',
  'narrator_sections',
  'narrator_comments',
  'narrator_takes',
  'review_versions',
  'review_share_links',
  'review_comments',
  'activity_events',
  'narration_take_comments',
  'video_analytics',
] as const;

export type ScopedTable = (typeof SCOPED_TABLES)[number];

const SCOPED_TABLE_SET: ReadonlySet<string> = new Set(SCOPED_TABLES);

export class ResourceNotInWorkspaceError extends Error {
  constructor(
    public readonly table: string,
    public readonly resourceId: string,
  ) {
    super(`Resource ${resourceId} not found in this workspace.`);
    this.name = 'ResourceNotInWorkspaceError';
  }
}

class UnknownTableError extends Error {
  constructor(table: string) {
    super(`Unknown scoped table: ${table}. Add it to SCOPED_TABLES if it carries workspace_id.`);
    this.name = 'UnknownTableError';
  }
}

function assertSafeTable(table: string): asserts table is ScopedTable {
  if (!SCOPED_TABLE_SET.has(table)) throw new UnknownTableError(table);
}

/**
 * Throw if the row isn't in the workspace. Use right at the top of a
 * mutation handler, before issuing the UPDATE / DELETE / etc.
 *
 * The table name is interpolated into the SQL — it's safe because
 * `assertSafeTable` checks against a fixed allowlist of literal strings.
 */
export async function assertOwnsResource(
  table: ScopedTable,
  resourceId: string,
  workspaceId: string,
): Promise<void> {
  assertSafeTable(table);
  if (!resourceId) throw new ResourceNotInWorkspaceError(table, '');
  const { rows } = await sql.query(
    `SELECT 1 FROM ${table} WHERE id = $1::uuid AND workspace_id = $2::uuid LIMIT 1`,
    [resourceId, workspaceId],
  );
  if (rows.length === 0) throw new ResourceNotInWorkspaceError(table, resourceId);
}

/**
 * Fetch a single row scoped to the workspace. Returns null if the row
 * doesn't exist OR doesn't belong to the workspace — callers can't
 * distinguish, which is the desired behaviour (don't leak existence).
 */
export async function getResourceInWorkspace<R extends { id: string; workspace_id: string }>(
  table: ScopedTable,
  resourceId: string,
  workspaceId: string,
): Promise<R | null> {
  assertSafeTable(table);
  if (!resourceId) return null;
  const { rows } = await sql.query<R>(
    `SELECT * FROM ${table} WHERE id = $1::uuid AND workspace_id = $2::uuid LIMIT 1`,
    [resourceId, workspaceId],
  );
  return rows[0] ?? null;
}
