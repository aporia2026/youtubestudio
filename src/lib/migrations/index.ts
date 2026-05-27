import { createClient, type VercelClient } from '@vercel/postgres';
import type { Migration, MigrationClient } from './types';
import migration0001 from './0001_init_schema_migrations';
import migration0002 from './0002_create_workspaces';
import migration0003 from './0003_extend_collaborators_with_auth';
import migration0004 from './0004_create_workspace_members';
import migration0005 from './0005_bootstrap_admin_and_default_workspace';
import migration0006 from './0006_create_narration_take_comments';
import migration0010 from './0010_add_assignment_full_audio';
import migration0011 from './0011_add_workspace_id_columns';
import migration0012 from './0012_backfill_workspace_id';
import migration0013 from './0013_enforce_workspace_id';
import migration0014 from './0014_create_admin_audit_log';
import migration0015 from './0015_create_rate_limits';
import migration0016 from './0016_add_channel_brand_kit';
import migration0017 from './0017_create_messages';
import migration0018 from './0018_create_video_analytics';
import migration0019 from './0019_channels_workspace_unique';
import migration0020 from './0020_create_dubbed_voiceovers';
import migration0021 from './0021_create_shorts';
import migration0022 from './0022_create_production_doc_styles';
import migration0023 from './0023_create_broll_clips';
import migration0024 from './0024_create_ab_tests';
import migration0025 from './0025_create_critic_panels';
import migration0026 from './0026_create_retention_predictions';
import migration0027 from './0027_create_dip_analyses';
import migration0028 from './0028_create_cannibalization_alerts';
import migration0029 from './0029_create_ask_studio_questions';
import migration0030 from './0030_create_webhook_subscriptions';
import migration0031 from './0031_create_youtube_comments';
import migration0032 from './0032_create_workflows';
import migration0033 from './0033_create_ai_spend_log';
import migration0034 from './0034_create_workspace_model_defaults';
import migration0035 from './0035_create_published_videos';
import migration0036 from './0036_google_auth_tokens_workspace_unique';
import migration0036b from './0036b_reheal_workspace_id_post_live_site';
import migration0036c from './0036c_reheal_post_0011_tables';
import migration0037 from './0037_add_listing_indexes';
import migration0038 from './0038_competitor_channels_workspace_unique';
import migration0039 from './0039_published_videos_idempotency';
import migration0040 from './0040_create_prediction_outcomes';
import migration0041 from './0041_create_video_analytics_history';
import migration0042 from './0042_add_traffic_source_breakdown';
import migration0043 from './0043_create_video_search_terms';
import migration0044 from './0044_create_video_format_tags';
import migration0045 from './0045_create_video_breakout_fires';
import migration0046 from './0046_create_insight_digests';
import migration0047 from './0047_create_saved_catalog_views';
import migration0048 from './0048_drop_redundant_history_index';
import migration0049 from './0049_create_user_history';
import migration0050 from './0050_create_team_hub_audit_log';
import migration0051 from './0051_add_narrator_take_alignment';
import migration0052 from './0052_create_pipeline_tables';
import migration0053 from './0053_pipeline_thumbnail_editor';
import migration0054 from './0054_pipeline_seo_step';
import migration0055 from './0055_create_niche_finder';
import migration0056 from './0056_add_author_role_to_review_comments';
import migration0057 from './0057_fix_inbox_owner_backfill';
import migration0058 from './0058_create_niche_discoveries';
import migration0059 from './0059_create_niche_watchlist';
import migration0060 from './0060_create_niche_search_presets';
import migration0061 from './0061_reheal_workspace_unique_constraints';
import migration0062 from './0062_create_project_channels';
import migration0063 from './0063_create_niche_favorites';
import migration0064 from './0064_create_niche_taxonomy';
import migration0065 from './0065_extend_watchlist_for_searches';
import migration0066 from './0066_render_jobs_lambda_columns';
import migration0067 from './0067_create_voiceover_alignments';
import migration0068 from './0068_restore_workspace_members_workspace_id';
import migration0069 from './0069_create_review_player_timing_samples';
import migration0070 from './0070_add_channel_visual_brand_kit';
// TODO(broll-plan): re-enable once 0071_add_default_broll_model_to_collaborators.ts is created.
// import migration0071 from './0071_add_default_broll_model_to_collaborators';
import migration0072 from './0072_broll_clips_production_doc_id';
import migration0073 from './0073_reheal_composite_workspace_constraints';
import migration0074 from './0074_create_youtube_analyses';
import migration0075 from './0075_workspace_analyzer_daily_cap_override';
import migration0076 from './0076_competitor_naming_bridge';
import migration0077 from './0077_saved_channel_names_workspace_scope';
import migration0078 from './0078_create_editor_telemetry';
import migration0079 from './0079_user_history_version_column';
import migration0080 from './0080_extend_production_doc_styles_with_refs';
import migration0081 from './0081_style_constraints_and_indexes';
import migration0082 from './0082_style_ref_content_validation';
import migration0083 from './0083_create_generation_events';
import migration0084 from './0084_create_project_assets';
import migration0085 from './0085_ask_studio_thread_replies';
import migration0086 from './0086_add_channel_description_brief';
import migration0087 from './0087_niches_workspace_name_unique';
import migration0088 from './0088_create_oauth_tokens';
import migration0089 from './0089_add_workspace_tts_settings';
import migration0090 from './0090_create_video_stage_transitions';
import migration0091 from './0091_add_projects_current_stage';
import migration0092 from './0092_add_schedule_pipeline_run_video';
import migration0093 from './0093_add_pipeline_preset_script_style';
import migration0094 from './0094_add_pipeline_video_style_override';

/**
 * Ordered list of all migrations. Append new migrations to the end with the
 * next sequential id. NEVER reorder, renumber, or delete a migration that has
 * been applied to a real database — instead, write a new migration that
 * corrects the prior one.
 */
export const allMigrations: readonly Migration[] = Object.freeze([
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
  migration0028,
  migration0029,
  migration0030,
  migration0031,
  migration0032,
  migration0033,
  migration0034,
  migration0035,
  migration0036,
  migration0036b,
  migration0036c,
  migration0037,
  migration0038,
  migration0039,
  migration0040,
  migration0041,
  migration0042,
  migration0043,
  migration0044,
  migration0045,
  migration0046,
  migration0047,
  migration0048,
  migration0049,
  migration0050,
  migration0051,
  migration0052,
  migration0053,
  migration0054,
  migration0055,
  migration0056,
  migration0057,
  migration0058,
  migration0059,
  migration0060,
  migration0061,
  migration0062,
  migration0063,
  migration0064,
  migration0065,
  migration0066,
  migration0067,
  migration0068,
  migration0069,
  migration0070,
  // TODO(broll-plan): re-add `migration0071,` once the file is created.
  migration0072,
  migration0073,
  migration0074,
  migration0075,
  migration0076,
  migration0077,
  migration0078,
  migration0079,
  migration0080,
  migration0081,
  migration0082,
  migration0083,
  migration0084,
  migration0085,
  migration0086,
  migration0087,
  migration0088,
  migration0089,
  migration0090,
  migration0091,
  migration0092,
  migration0093,
  migration0094,
]);

/**
 * Postgres advisory-lock id used to serialise migration runs. Stored as a
 * decimal string because Postgres parses `pg_advisory_lock($1::bigint)` from
 * either a number or a string param, and the tsconfig targets ES2017 which
 * predates the BigInt literal syntax. Change only if you intend to break
 * compatibility with running deployments.
 */
const MIGRATION_LOCK_ID = '7314551729482361';

export interface MigrationStatus {
  id: string;
  description: string;
  applied: boolean;
  appliedAt: Date | null;
}

export interface MigrationRunResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Acquire a lock-protected client. The migration table is bootstrapped here so
 * that even on a fresh database the runner can immediately query it.
 */
async function withMigrationClient<T>(
  fn: (client: VercelClient) => Promise<T>,
  opts: { connectionString?: string } = {},
): Promise<T> {
  // DDL must NOT use the pooled URL (pgbouncer transaction mode breaks DDL).
  const connectionString =
    opts.connectionString ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error(
      'POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL must be set to run migrations.',
    );
  }

  const client = createClient({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Pure logic: given the full list of declared migrations and the set of ids
 * recorded as applied, decide which to apply next, in order. Exposed for unit
 * testing without needing a database.
 */
export function planPending(
  declared: readonly Migration[],
  appliedIds: ReadonlySet<string>,
): Migration[] {
  const pending: Migration[] = [];
  let seenUnapplied = false;
  for (const m of declared) {
    if (appliedIds.has(m.id)) {
      if (seenUnapplied) {
        throw new Error(
          `Migration ordering violation: ${m.id} is marked applied but a prior migration is not. ` +
            `This usually means migrations were renumbered after being applied. Refusing to continue.`,
        );
      }
    } else {
      seenUnapplied = true;
      pending.push(m);
    }
  }
  return pending;
}

/**
 * Run a single migration inside its own transaction against the supplied
 * client. Exposed for unit testing the apply path with a mock client.
 */
export async function runOne(client: MigrationClient, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    await migration.up(client);
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort; original error wins
    }
    throw new Error(
      `Migration ${migration.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Apply every pending migration in declared order. */
export async function applyPending(opts: { connectionString?: string } = {}): Promise<MigrationRunResult> {
  return withMigrationClient(async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const appliedIds = new Set(rows.map((r) => r.id));
    const pending = planPending(allMigrations, appliedIds);

    const applied: string[] = [];
    for (const migration of pending) {
      await runOne(client, migration);
      applied.push(migration.id);
    }

    return {
      applied,
      alreadyApplied: allMigrations.filter((m) => appliedIds.has(m.id)).map((m) => m.id),
    };
  }, opts);
}

/** Report status of every declared migration. */
export async function getStatus(opts: { connectionString?: string } = {}): Promise<MigrationStatus[]> {
  return withMigrationClient(async (client) => {
    const { rows } = await client.query<{ id: string; applied_at: Date }>(
      'SELECT id, applied_at FROM schema_migrations',
    );
    const appliedMap = new Map(rows.map((r) => [r.id, r.applied_at]));
    return allMigrations.map((m) => ({
      id: m.id,
      description: m.description,
      applied: appliedMap.has(m.id),
      appliedAt: appliedMap.get(m.id) ?? null,
    }));
  }, opts);
}
