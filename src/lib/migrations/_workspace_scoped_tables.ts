/**
 * Single source of truth for which tables are tenant-scoped (i.e. carry a
 * `workspace_id` column). Any new table added in future migrations should be
 * added here so the workspace_id rollout, the tenancy test, and the admin
 * "delete workspace" cascade all see a consistent picture.
 *
 * The two arrays are exclusive:
 *   - ROOT tables receive workspace_id directly via the bootstrap workspace.
 *   - CHILD tables inherit their workspace_id from a parent table at backfill
 *     time, then carry their own workspace_id column from that point on
 *     (defense in depth: queries can scope on any table without joins).
 *
 * Skipped (intentionally not tenant-scoped):
 *   - schema_migrations          — runner bookkeeping
 *   - workspaces                 — IS the tenant; doesn't have a workspace_id
 *   - workspace_members          — links to a workspace via PK
 *   - collaborators              — global identity table; multi-tenant via workspace_members
 *   - schedule_item_channels     — pure junction table
 *   - schedule_item_dependencies — pure junction table
 *   - narrator_profiles          — deprecated, slated for removal
 */

export const ROOT_TENANT_TABLES = [
  // Original phase-1 root tables.
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
  'production_doc_styles',
  // Post-rollout tables added 2026-05-26 after a `CREATE TABLE` audit
  // showed they all declare workspace_id in their own CREATE (so the
  // backfill UPDATE is a no-op for them — the column is already
  // populated at INSERT time). Listing them here keeps:
  //   1. the `workspace-scope.ts` runtime allowlist in sync,
  //   2. any future workspace-deletion cascade aware of them, and
  //   3. the tenancy test exercising every workspace-scoped surface.
  // Several are denormalized children (pipeline_run_videos carries its
  // own workspace_id rather than join through pipeline_runs); they
  // sit under ROOT rather than CHILD because they don't need parent-
  // join backfill.
  'ab_test_snapshots',
  'ab_tests',
  'admin_audit_log',
  'ai_spend_log',
  'ask_studio_questions',
  'broll_clips',
  'cannibalization_alerts',
  'comment_sync_runs',
  'critic_panel_events',
  'critic_panels',
  'dip_analyses',
  'dubbed_voiceovers',
  'editor_telemetry',
  'insight_digests',
  'messages',
  'niche_discoveries',
  'niche_favorite_briefs',
  'niche_favorite_videos',
  'niche_favorites',
  'niche_reports',
  'niche_search_presets',
  'niche_taxonomy_scores',
  'niche_watchlist',
  'pipeline_presets',
  'pipeline_run_videos',
  'pipeline_runs',
  'prediction_outcomes',
  'published_videos',
  'retention_predictions',
  'saved_catalog_views',
  'shorts',
  'style_reference_images',
  'style_test_renders',
  'team_hub_audit_log',
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
  'video_search_terms',
  'video_stage_transitions',
  'webhook_deliveries',
  'webhook_subscriptions',
  'workflow_action_runs',
  'workflow_rules',
  'workspace_model_defaults',
  'youtube_analyses',
  'youtube_comments',
] as const;

export interface ChildTenantTable {
  table: string;
  parentTable: string;
  fkColumn: string;
  /**
   * Backfill depth — how many parent-resolution passes are required before
   * this table's `workspace_id` can be set.
   *   1 = parent is a root table (depth 0)
   *   2 = parent is a depth-1 child
   *   3 = parent is a depth-2 child
   *   4 = parent is a depth-3 child
   * Each pass must run after every shallower pass has completed.
   */
  depth: 1 | 2 | 3 | 4;
}

export const CHILD_TENANT_TABLES: readonly ChildTenantTable[] = [
  // depth-1: parent is a root table
  { table: 'scripts', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'qa_sessions', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'media_assets', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'production_doc_notes', parentTable: 'user_history', fkColumn: 'doc_id', depth: 1 },
  { table: 'youtube_references', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'oauth_tokens', parentTable: 'channels', fkColumn: 'channel_id', depth: 1 },
  { table: 'competitor_videos', parentTable: 'competitor_channels', fkColumn: 'competitor_id', depth: 1 },
  { table: 'series_parts', parentTable: 'series', fkColumn: 'series_id', depth: 1 },
  { table: 'editor_assignments', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'narrator_assignments', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },
  { table: 'review_versions', parentTable: 'review_projects', fkColumn: 'project_id', depth: 1 },
  { table: 'review_share_links', parentTable: 'review_projects', fkColumn: 'project_id', depth: 1 },
  { table: 'activity_events', parentTable: 'projects', fkColumn: 'project_id', depth: 1 },

  // depth-2: parent is a depth-1 child
  { table: 'narrator_sections', parentTable: 'narrator_assignments', fkColumn: 'assignment_id', depth: 2 },
  { table: 'narrator_comments', parentTable: 'narrator_assignments', fkColumn: 'assignment_id', depth: 2 },
  { table: 'review_comments', parentTable: 'review_versions', fkColumn: 'version_id', depth: 2 },

  // depth-3: parent is a depth-2 child
  { table: 'narrator_takes', parentTable: 'narrator_sections', fkColumn: 'section_id', depth: 3 },

  // depth-4: parent is a depth-3 child (added in 0006_create_narration_take_comments)
  { table: 'narration_take_comments', parentTable: 'narrator_takes', fkColumn: 'take_id', depth: 4 },
];

/** Every tenant-scoped table — for ALTER TABLE / index / NOT NULL passes. */
export const ALL_TENANT_TABLES: readonly string[] = [
  ...ROOT_TENANT_TABLES,
  ...CHILD_TENANT_TABLES.map((c) => c.table),
];

/** Identifier validation — defence in depth against ever interpolating user
 *  input here. The constants above are hardcoded, but a static check makes
 *  any future drift loud and obvious. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
for (const t of ALL_TENANT_TABLES) {
  if (!SAFE_IDENT.test(t)) {
    throw new Error(`Tenant table list contains an unsafe identifier: ${JSON.stringify(t)}`);
  }
}
for (const c of CHILD_TENANT_TABLES) {
  if (!SAFE_IDENT.test(c.parentTable) || !SAFE_IDENT.test(c.fkColumn)) {
    throw new Error(
      `Child tenant table descriptor contains an unsafe identifier: ${JSON.stringify(c)}`,
    );
  }
}
