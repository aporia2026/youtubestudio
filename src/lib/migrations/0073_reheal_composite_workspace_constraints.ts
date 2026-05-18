import type { Migration, MigrationClient } from './types';

/**
 * Schema-drift heal: restore the workspace-scoped composite constraints
 * (PRIMARY KEY / UNIQUE) that the live-site interlude's
 * `DROP COLUMN workspace_id CASCADE` took with it.
 *
 * Background:
 *   - 0036b re-added the `workspace_id` column on the original tenant
 *     tables; 0036c did the same for tables created by 0017-0035.
 *   - Neither heal restored the constraints that the CASCADE dropped as
 *     dependants of the column. 0061 re-healed two UNIQUEs (channels,
 *     google_auth_tokens); 0068 re-healed the workspace_members
 *     composite PK. Three more siblings were missed:
 *
 *       1. `workspace_model_defaults` — original
 *          `PRIMARY KEY (workspace_id, scope)`. Symptom: the
 *          /settings model-picker (and the in-niche-finder model
 *          switcher) report
 *          "Save failed — Could not save model preference — there is
 *          no unique or exclusion constraint matching the ON CONFLICT
 *          specification".
 *       2. `video_analytics` — original
 *          `PRIMARY KEY (workspace_id, youtube_video_id)`. Same shape
 *          of failure on every analytics sync upsert.
 *       3. `youtube_comments` — original named UNIQUE
 *          `youtube_comments_workspace_yt_id_unique
 *           (workspace_id, youtube_comment_id)`. Same shape of failure
 *          on every comment-ingest upsert. The table's `id` PK is on
 *          a separate column and survived the CASCADE.
 *
 * What this migration does, per affected table:
 *   1. Short-circuit if the constraint is already present (a fresh DB
 *      that never went through the drift has it from the CREATE TABLE,
 *      and a drifted DB that has been hand-patched also passes through
 *      cleanly).
 *   2. Refuse to guess on duplicates: if any rows violate the
 *      constraint, throw with the offending keys named. The drift
 *      shouldn't have introduced duplicates (the ON CONFLICT upserts
 *      that would have created them failed entirely once the
 *      constraint was gone), but the check costs nothing and matches
 *      the pattern in 0068.
 *   3. Add the constraint with the same name it would have had on a
 *      fresh CREATE TABLE.
 *
 * Why a new id instead of editing 0036c / 0061 / 0068:
 *   - schema_migrations is append-only by convention (see 0036b and
 *     0061 headers). Mutating an applied migration would require
 *     bypassing the runner's ordering guard.
 */

interface CompositeHeal {
  table: string;
  /** Constraint kind to add back. PRIMARY KEY = the table's pkey; the
   *  CASCADE removed it whole, so no DROP IF EXISTS is needed.
   *  UNIQUE  = a named constraint on a non-pkey column tuple.       */
  kind: 'PRIMARY KEY' | 'UNIQUE';
  /** Constraint name. For PRIMARY KEY this is purely cosmetic (Postgres
   *  auto-names if absent), but spelling it out keeps the schema
   *  bit-identical to a fresh migrate. */
  name: string;
  /** Ordered column list that the constraint covers. */
  columns: readonly string[];
}

const HEALS: readonly CompositeHeal[] = [
  {
    table: 'workspace_model_defaults',
    kind: 'PRIMARY KEY',
    name: 'workspace_model_defaults_pkey',
    columns: ['workspace_id', 'scope'],
  },
  {
    table: 'video_analytics',
    kind: 'PRIMARY KEY',
    name: 'video_analytics_pkey',
    columns: ['workspace_id', 'youtube_video_id'],
  },
  {
    table: 'youtube_comments',
    kind: 'UNIQUE',
    name: 'youtube_comments_workspace_yt_id_unique',
    columns: ['workspace_id', 'youtube_comment_id'],
  },
];

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
for (const h of HEALS) {
  if (!SAFE_IDENT.test(h.table)) throw new Error(`Unsafe table identifier: ${h.table}`);
  if (!SAFE_IDENT.test(h.name)) throw new Error(`Unsafe constraint identifier: ${h.name}`);
  for (const c of h.columns) {
    if (!SAFE_IDENT.test(c)) throw new Error(`Unsafe column identifier: ${c}`);
  }
}

const migration: Migration = {
  id: '0073_reheal_composite_workspace_constraints',
  description:
    'Re-add composite workspace-scoped PK/UNIQUE constraints on workspace_model_defaults, video_analytics, and youtube_comments dropped by the live-site CASCADE',

  async up(client) {
    for (const heal of HEALS) {
      if (!(await tableExists(client, heal.table))) continue; // fresh DB without this table yet — CREATE TABLE will declare the constraint correctly.
      if (await constraintPresent(client, heal)) continue;

      const duplicates = await findDuplicateKeys(client, heal);
      if (duplicates.length > 0) {
        const sample = duplicates
          .slice(0, 5)
          .map((d) => `(${d.key}) ×${d.count}`)
          .join(', ');
        throw new Error(
          `Cannot re-add ${heal.kind} ${heal.name} on ${heal.table}: ` +
          `${duplicates.length} duplicate key group(s) on (${heal.columns.join(', ')}). ` +
          `Sample: ${sample}. Reconcile by hand (DELETE the surplus rows, keep the latest) ` +
          `then re-run \`npm run db:migrate\`.`,
        );
      }

      const colList = heal.columns.join(', ');
      await client.query(
        `ALTER TABLE ${heal.table}
           ADD CONSTRAINT ${heal.name} ${heal.kind} (${colList})`,
      );
    }
  },

  async down(client) {
    for (const heal of HEALS) {
      await client.query(
        `ALTER TABLE IF EXISTS ${heal.table} DROP CONSTRAINT IF EXISTS ${heal.name}`,
      );
    }
  },
};

async function tableExists(client: MigrationClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = $1
     ) AS exists`,
    [table],
  );
  return Boolean(rows[0]?.exists);
}

/** True when a PRIMARY KEY / UNIQUE constraint with the expected name AND
 *  expected column tuple is already on the table. We match on both name
 *  and columns so an unrelated constraint with the same name (or the
 *  desired columns but a different name) doesn't trick us into skipping. */
async function constraintPresent(
  client: MigrationClient,
  heal: CompositeHeal,
): Promise<boolean> {
  const contype = heal.kind === 'PRIMARY KEY' ? 'p' : 'u';
  const { rows } = await client.query<{ columns: string[] }>(
    `SELECT array_agg(a.attname ORDER BY k.ord) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = $1
        AND n.nspname = ANY (current_schemas(false))
        AND c.conname = $2
        AND c.contype = $3
      GROUP BY c.oid`,
    [heal.table, heal.name, contype],
  );
  const found = rows[0]?.columns;
  if (!found) return false;
  if (found.length !== heal.columns.length) return false;
  for (let i = 0; i < heal.columns.length; i++) {
    if (found[i] !== heal.columns[i]) return false;
  }
  return true;
}

interface DuplicateGroup {
  key: string;
  count: number;
}

async function findDuplicateKeys(
  client: MigrationClient,
  heal: CompositeHeal,
): Promise<DuplicateGroup[]> {
  const colList = heal.columns.join(', ');
  const keyExpr = heal.columns.map((c) => `${c}::text`).join(` || '|' || `);
  const { rows } = await client.query<{ key: string; count: string }>(
    `SELECT ${keyExpr} AS key, COUNT(*)::text AS count
       FROM ${heal.table}
      GROUP BY ${colList}
     HAVING COUNT(*) > 1
      LIMIT 50`,
  );
  return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
}

export default migration;
