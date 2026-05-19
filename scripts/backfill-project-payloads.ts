/**
 * One-time backfill: walk every `kind = 'production_doc'` row in
 * `user_history` and rewrite its JSONB `payload` column through the
 * canonical migrator from
 * `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * Before the parity refactor, the production-doc page persisted assets
 * through three different code paths and the editor read only a subset.
 * Existing rows therefore have varying mixes of fields — some have
 * `voiceoverUrl` (saved at the initial save), some don't; some store
 * rowImages as `Record<number, string>`, others as the legacy
 * `RowImageState[]` array; etc. The new editor at `/edit/[projectId]`
 * runs `migratePayload` on read, so functionally everything works —
 * but the canonical shape doesn't actually land in the database until
 * someone re-saves the row.
 *
 * This script lands the canonical shape eagerly so:
 *
 *   1. Existing projects open in the editor with the same fields a
 *      newly-generated project does (no "open production-doc once to
 *      backfill" dance).
 *   2. The migrator's diagnostic logs at runtime stop reporting
 *      dropped / defaulted fields on every load.
 *   3. The `version` column gets bumped exactly once per row, giving
 *      us a clean baseline for any future optimistic-concurrency work.
 *
 * Idempotent: re-running just re-migrates rows that are already
 * canonical, which is a no-op on field contents (and bumps version
 * harmlessly). Safe to re-run as many times as needed.
 *
 * Usage:
 *   $env:POSTGRES_URL_NON_POOLING = "..."     # or POSTGRES_URL
 *   npx tsx scripts/backfill-project-payloads.ts             # dry-run
 *   npx tsx scripts/backfill-project-payloads.ts --apply     # write
 *
 * Dry-run mode reports which rows would change and prints aggregate
 * counts of dropped + defaulted fields; nothing is written. Always
 * run dry-run first against production data.
 */
import { createClient, type VercelClient } from '@vercel/postgres';
import { migratePayload, PROJECT_PAYLOAD_VERSION } from '../src/lib/project/payload';

interface Row {
  id: string;
  workspace_id: string;
  collaborator_id: string;
  payload: unknown;
  version: number;
}

interface RunStats {
  rowsScanned: number;
  rowsRewritten: number;
  rowsAlreadyCanonical: number;
  rowsFailed: number;
  totalDroppedFields: Record<string, number>;
  totalDefaultedFields: Record<string, number>;
}

function blankStats(): RunStats {
  return {
    rowsScanned: 0,
    rowsRewritten: 0,
    rowsAlreadyCanonical: 0,
    rowsFailed: 0,
    totalDroppedFields: {},
    totalDefaultedFields: {},
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

async function fetchRows(client: VercelClient): Promise<Row[]> {
  const { rows } = await client.query<Row>(
    `SELECT id, workspace_id, collaborator_id, payload, version
       FROM user_history
      WHERE kind = 'production_doc'
      ORDER BY created_at ASC`,
  );
  return rows;
}

function payloadsEqual(a: unknown, b: unknown): boolean {
  // Cheap byte-equal check on the JSON serialisation. JSONB comparison
  // would be more correct but requires a Postgres round-trip; the
  // string compare suffices because we deterministically stringify
  // both sides with the same Node behavior.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) {
    process.stderr.write('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) not set\n');
    process.exit(1);
  }

  process.stdout.write(
    `Backfill mode: ${apply ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}\n` +
      `Target version: ${PROJECT_PAYLOAD_VERSION}\n\n`,
  );

  const client = createClient({ connectionString: cs });
  await client.connect();
  const stats = blankStats();

  try {
    const rows = await fetchRows(client);
    stats.rowsScanned = rows.length;
    process.stdout.write(`Scanning ${rows.length} production_doc rows…\n\n`);

    for (const row of rows) {
      const { payload: migrated, droppedFields, appliedDefaults } = migratePayload(row.payload);
      droppedFields.forEach((f) => bump(stats.totalDroppedFields, f));
      appliedDefaults.forEach((f) => bump(stats.totalDefaultedFields, f));

      if (payloadsEqual(row.payload, migrated)) {
        stats.rowsAlreadyCanonical += 1;
        continue;
      }

      if (apply) {
        try {
          await client.query(
            `UPDATE user_history
                SET payload = $1::jsonb,
                    version = version + 1
              WHERE id = $2::uuid`,
            [JSON.stringify(migrated), row.id],
          );
          stats.rowsRewritten += 1;
          process.stdout.write(
            `  ✓ ${row.id}  ws=${row.workspace_id.slice(0, 8)}…  ` +
              `dropped=${droppedFields.length}  defaulted=${appliedDefaults.length}\n`,
          );
        } catch (err) {
          stats.rowsFailed += 1;
          process.stderr.write(
            `  ✗ ${row.id}  ws=${row.workspace_id.slice(0, 8)}…  ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        stats.rowsRewritten += 1; // counted as "would write" in dry-run
        process.stdout.write(
          `  · ${row.id}  ws=${row.workspace_id.slice(0, 8)}…  ` +
            `dropped=${droppedFields.length}  defaulted=${appliedDefaults.length}\n`,
        );
      }
    }
  } finally {
    await client.end();
  }

  // Summary.
  process.stdout.write('\n');
  process.stdout.write(`Rows scanned:           ${stats.rowsScanned}\n`);
  process.stdout.write(`Rows already canonical: ${stats.rowsAlreadyCanonical}\n`);
  process.stdout.write(
    `Rows ${apply ? 'rewritten' : 'that would change'}: ${stats.rowsRewritten}\n`,
  );
  if (stats.rowsFailed > 0) {
    process.stdout.write(`Rows failed:            ${stats.rowsFailed}\n`);
  }

  const droppedEntries = Object.entries(stats.totalDroppedFields).sort((a, b) => b[1] - a[1]);
  if (droppedEntries.length > 0) {
    process.stdout.write('\nDropped fields (key — count across all rows):\n');
    for (const [k, n] of droppedEntries) {
      process.stdout.write(`  ${k}: ${n}\n`);
    }
  }

  const defaultedEntries = Object.entries(stats.totalDefaultedFields).sort((a, b) => b[1] - a[1]);
  if (defaultedEntries.length > 0) {
    process.stdout.write('\nDefaulted fields (key — count across all rows):\n');
    for (const [k, n] of defaultedEntries) {
      process.stdout.write(`  ${k}: ${n}\n`);
    }
  }

  if (!apply && stats.rowsRewritten > 0) {
    process.stdout.write(
      `\nDry run complete. Re-run with --apply to write the canonical shape to ${stats.rowsRewritten} row${stats.rowsRewritten === 1 ? '' : 's'}.\n`,
    );
  } else if (apply) {
    process.stdout.write('\nApply complete.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
