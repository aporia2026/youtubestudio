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
import migration0037 from './0037_add_listing_indexes';
import migration0038 from './0038_competitor_channels_workspace_unique';
import migration0039 from './0039_published_videos_idempotency';
import migration0040 from './0040_create_prediction_outcomes';
import migration0041 from './0041_create_video_analytics_history';
import migration0042 from './0042_add_traffic_source_breakdown';
import migration0043 from './0043_create_video_search_terms';

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
  migration0037,
  migration0038,
  migration0039,
  migration0040,
  migration0041,
  migration0042,
  migration0043,
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
