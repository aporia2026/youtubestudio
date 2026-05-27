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
 * Tables that carry a `workspace_id` column. Mirrors the canonical
 * list in src/lib/migrations/_workspace_scoped_tables.ts (root +
 * child tenant tables) — kept here as an explicit allowlist so a
 * typo can't allow arbitrary table names through the helpers.
 *
 * Kept in alphabetical order so a missing addition is easier to spot
 * on a diff. The tenancy test at tests/scoped-tables-coverage.test.ts
 * asserts this list matches the canonical migration list (added
 * 2026-05-26 alongside the post-rollout table backfill).
 */
export const SCOPED_TABLES = [
  'ab_test_snapshots',
  'ab_tests',
  'activity_events',
  'admin_audit_log',
  'ai_spend_log',
  'ask_studio_questions',
  'broll_clips',
  'cannibalization_alerts',
  'channels',
  'comment_sync_runs',
  'competitor_channels',
  'competitor_videos',
  'critic_panel_events',
  'critic_panels',
  'dip_analyses',
  'dubbed_voiceovers',
  'editor_assignments',
  'editor_telemetry',
  'google_auth_tokens',
  'insight_digests',
  'media_assets',
  'messages',
  'narration_take_comments',
  'narrator_assignments',
  'narrator_comments',
  'narrator_sections',
  'narrator_takes',
  'niche_discoveries',
  'niche_favorite_briefs',
  'niche_favorite_videos',
  'niche_favorites',
  'niche_reports',
  'niche_search_presets',
  'niche_taxonomy_scores',
  'niche_watchlist',
  'niches',
  'oauth_tokens',
  'pipeline_presets',
  'pipeline_run_videos',
  'pipeline_runs',
  'prediction_outcomes',
  'production_doc_styles',
  'projects',
  'published_videos',
  'qa_sessions',
  'reference_library',
  'retention_predictions',
  'review_comments',
  'review_projects',
  'review_share_links',
  'review_versions',
  'saved_catalog_views',
  'saved_channel_names',
  'schedule_items',
  'scripts',
  'series',
  'series_parts',
  'shorts',
  'style_reference_images',
  'style_test_renders',
  'team_hub_audit_log',
  'templates',
  'thumbnail_template_presets',
  // Feature-preset bundle tables (migration 0097).
  'script_presets',
  'qa_presets',
  'narration_presets',
  'idea_presets',
  'user_history',
  'video_analytics',
  'video_analytics_history',
  'video_breakout_fires',
  'video_format_tags',
  'video_ideas',
  'video_search_terms',
  'video_stage_transitions',
  'webhook_deliveries',
  'webhook_subscriptions',
  'workflow_action_runs',
  'workflow_drafts',
  'workflow_rules',
  'workspace_model_defaults',
  'youtube_analyses',
  'youtube_comments',
  'youtube_references',
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
